import { Inject, Injectable } from '@nestjs/common';
import {
  type CashTender,
  type CashTenderResultDto,
  type CreatePaymentIntent,
  type ForwardOutcomeRequest,
  type OfflineCollection,
  PAYMENT_PERMISSIONS,
  type PaymentAttemptDto,
  type PaymentEventDto,
  type PaymentIntentDto,
  type PaymentIntentListQuery,
  type Page,
} from '@pos/contracts';
import { newId, type TenantScopedDb, type TenantUnitOfWork } from '@pos/db';

import {
  AuthorizationService,
  ConflictError,
  NotFoundError,
  RequestContextService,
  UnitOfWork,
  ValidationError,
  isOperator,
  principalReaches,
} from '../kernel/public/index.js';
import { CashTenderError, calculateCashTender } from './domain/cash.js';
import { netCollected } from './domain/state-machine.js';
import { type Caller, PaymentsLedger } from './ledger.service.js';
import { PAYMENTS_CONFIG, type PaymentsConfig } from './payments.config.js';
import { PaymentsRunner } from './payments-runner.js';
import { ORDER_PORT, type CheckForPayment, type OrderPort } from './ports/order.port.js';
import {
  type AttemptRow,
  type EventRow,
  type IntentRow,
  type ProviderAccountRow,
  type TerminalRow,
  toAttemptDto,
  toEventDto,
  toIntentDto,
} from './rows.js';
import { terminalOfflineCapable } from './terminals.service.js';

/** Methods this slice takes through a provider adapter (card, wallet, QR, BNPL). Gift card, store credit and loyalty tenders are planned (ledger-backed). */
const PROVIDER_METHODS: readonly string[] = [
  'card_present',
  'card_not_present',
  'wallet',
  'qr',
  'bnpl',
];

const IN_FLIGHT = ['processing', 'authorized', 'uncertain'] as const;

@Injectable()
export class IntentsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly context: RequestContextService,
    private readonly runner: PaymentsRunner,
    private readonly ledger: PaymentsLedger,
    @Inject(ORDER_PORT) private readonly orders: OrderPort,
    @Inject(PAYMENTS_CONFIG) private readonly config: PaymentsConfig,
  ) {}

  // --- create (card/wallet/…): status `created`, nothing sent to a provider yet ---------------

  async create(input: CreatePaymentIntent): Promise<PaymentIntentDto> {
    await this.authz.assert(PAYMENT_PERMISSIONS.take, { kind: 'location', id: input.locationId });
    if (!PROVIDER_METHODS.includes(input.method))
      throw new ConflictError(
        'METHOD_NOT_SUPPORTED',
        `Tender "${input.method}" is not available yet`,
      );
    const { tenantId, actor, caller } = this.runner.request();
    return this.runner.run(tenantId, actor, async (uow) => {
      const check = await this.requirePayableCheck(
        uow,
        input.locationId,
        input.orderId,
        input.checkId,
      );
      const key = this.idempotencyKey(input.deviceId, input.clientIntentId);
      const existing = await this.byKey(uow.db, key);
      if (existing) return this.replay(uow.db, existing, input);

      const account = await this.pickAccount(uow.db, input, check.currency);
      const terminal = input.terminalId ? await this.requireTerminal(uow.db, input, account) : null;
      const amount = BigInt(input.amountMinor);
      await this.assertWithinOutstanding(uow.db, check, amount);

      const id = newId();
      const rows = await uow.db.query<IntentRow>(
        `INSERT INTO payments.payment_intents
           (id, tenant_id, location_id, order_id, check_id, idempotency_key, method, amount_minor, tip_minor, surcharge_minor,
            currency, settlement_status, provider_account_id, terminal_id, device_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'unsettled', $12, $13, $14, $15)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          id,
          uow.tenantId,
          input.locationId,
          input.orderId,
          input.checkId,
          key,
          input.method,
          amount,
          BigInt(input.tipMinor ?? '0'),
          BigInt(input.surchargeMinor ?? '0'),
          check.currency,
          account.id,
          terminal?.id ?? null,
          input.deviceId ?? caller.deviceId ?? null,
          caller.actorUserId ?? null,
        ],
      );
      if (!rows[0]) {
        const raced = await this.byKey(uow.db, key);
        if (raced) return this.replay(uow.db, raced, input);
        throw new ConflictError('IDEMPOTENCY_IN_FLIGHT', 'The same intent is being created');
      }
      await this.ledger.insertEvent(uow.db, id, caller, {
        kind: 'created',
        to: 'created',
        amountMinor: amount,
        payload: {
          method: input.method,
          providerAccountId: account.id,
          terminalId: terminal?.id ?? null,
        },
      });
      uow.audit({
        action: 'payments.intent.created',
        resourceKind: 'payment_intent',
        resourceId: id,
        locationId: input.locationId,
        after: {
          orderId: input.orderId,
          checkId: input.checkId,
          method: input.method,
          amountMinor: input.amountMinor,
        },
      });
      return toIntentDto(rows[0], null);
    });
  }

  // --- cash tender -----------------------------------------------------------------------------

  async cashTender(input: CashTender): Promise<CashTenderResultDto> {
    await this.authz.assert(PAYMENT_PERMISSIONS.take, { kind: 'location', id: input.locationId });
    const { tenantId, actor, caller } = this.runner.request();
    return this.runner.run(tenantId, actor, async (uow) => {
      const check = await this.requirePayableCheck(
        uow,
        input.locationId,
        input.orderId,
        input.checkId,
        true,
      );
      const key = this.idempotencyKey(input.deviceId, input.clientIntentId);
      const existing = await this.byKey(uow.db, key);
      if (existing) {
        if (existing.method !== 'cash' || existing.check_id !== input.checkId)
          throw new ConflictError(
            'IDEMPOTENCY_MISMATCH',
            'This key was used for a different payment',
          );
        return this.cashResultFromEvents(uow.db, existing);
      }
      const outstanding = check.totalMinor - (await this.committedAmount(uow.db, check.checkId));
      let calc;
      try {
        calc = calculateCashTender({
          outstandingMinor: outstanding,
          currency: check.currency,
          requestedMinor: input.amountMinor === undefined ? undefined : BigInt(input.amountMinor),
          tenderedMinor:
            input.tenderedMinor === undefined ? undefined : BigInt(input.tenderedMinor),
        });
      } catch (error) {
        if (error instanceof CashTenderError) throw new ConflictError(error.code, error.message);
        throw error;
      }
      const id = newId();
      const inserted = await uow.db.query<IntentRow>(
        `INSERT INTO payments.payment_intents
           (id, tenant_id, location_id, order_id, check_id, idempotency_key, method, amount_minor, currency,
            settlement_status, device_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'cash', $7, $8, 'not_applicable', $9, $10) RETURNING *`,
        [
          id,
          uow.tenantId,
          input.locationId,
          input.orderId,
          input.checkId,
          key,
          calc.dueMinor,
          check.currency,
          input.deviceId ?? caller.deviceId ?? null,
          caller.actorUserId ?? null,
        ],
      );
      await this.ledger.insertEvent(uow.db, id, caller, {
        kind: 'created',
        to: 'created',
        amountMinor: calc.dueMinor,
        payload: { method: 'cash' },
      });
      let intent = await this.ledger.transition(uow, inserted[0]!, 'processing', caller, {
        kind: 'submitted',
        amountMinor: calc.dueMinor,
      });
      intent = await this.ledger.transition(
        uow,
        intent,
        'captured',
        caller,
        {
          kind: 'captured',
          amountMinor: calc.dueMinor,
          payload: {
            tender: 'cash',
            outstandingMinor: outstanding.toString(),
            dueMinor: calc.dueMinor.toString(),
            tenderedMinor: calc.tenderedMinor.toString(),
            changeMinor: calc.changeMinor.toString(),
            roundingMinor: calc.roundingMinor.toString(),
            settlesBalance: calc.settlesBalance,
          },
        },
        { capturedMinor: calc.dueMinor, authorizedMinor: calc.dueMinor },
      );
      await this.orders.applyCashRounding(uow, {
        orderId: check.orderId,
        checkId: check.checkId,
        intentId: id,
        roundingMinor: calc.roundingMinor,
        tenderedMinor: calc.tenderedMinor,
        changeMinor: calc.changeMinor,
      });
      await this.ledger.syncOrder(uow, intent);
      this.ledger.emit(uow, 'payment.captured', intent, {
        tender: 'cash',
        changeMinor: calc.changeMinor.toString(),
        roundingMinor: calc.roundingMinor.toString(),
      });
      uow.audit({
        action: 'payments.cash.tendered',
        resourceKind: 'payment_intent',
        resourceId: id,
        locationId: input.locationId,
        after: {
          dueMinor: calc.dueMinor.toString(),
          tenderedMinor: calc.tenderedMinor.toString(),
          changeMinor: calc.changeMinor.toString(),
          roundingMinor: calc.roundingMinor.toString(),
        },
      });
      return {
        intent: toIntentDto(intent, null),
        dueMinor: calc.dueMinor.toString(),
        tenderedMinor: calc.tenderedMinor.toString(),
        changeMinor: calc.changeMinor.toString(),
        roundingMinor: calc.roundingMinor.toString(),
      };
    });
  }

  private async cashResultFromEvents(
    db: TenantScopedDb,
    intent: IntentRow,
  ): Promise<CashTenderResultDto> {
    const event = await db.maybeOne<EventRow>(
      `SELECT * FROM payments.payment_events WHERE tenant_id = $1 AND intent_id = $2 AND kind = 'captured'
        ORDER BY occurred_at DESC LIMIT 1`,
      [db.tenantId, intent.id],
    );
    const p = (event?.payload ?? {}) as Record<string, string>;
    return {
      intent: toIntentDto(intent, null),
      dueMinor: p.dueMinor ?? intent.amount_minor.toString(),
      tenderedMinor: p.tenderedMinor ?? intent.amount_minor.toString(),
      changeMinor: p.changeMinor ?? '0',
      roundingMinor: p.roundingMinor ?? '0',
    };
  }

  // --- offline (store-and-forward) -----------------------------------------------------------

  /**
   * Record a sale the terminal approved offline (docs/01 §8.3). It is stored as captured with a
   * pending forward outcome so the order can complete locally; the issuer may still decline.
   * Nothing is rejected here: the money has already moved at the terminal, so a sale outside the
   * configured caps is recorded and raises an exception instead.
   */
  async recordOfflineCollection(input: OfflineCollection): Promise<PaymentIntentDto> {
    await this.authz.assert(PAYMENT_PERMISSIONS.take, { kind: 'location', id: input.locationId });
    const { tenantId, actor, caller } = this.runner.request();
    return this.runner.run(tenantId, actor, async (uow) => {
      const check = await this.requirePayableCheck(
        uow,
        input.locationId,
        input.orderId,
        input.checkId,
        true,
      );
      const key = this.idempotencyKey(input.deviceId, input.clientIntentId);
      const existing = await this.byKey(uow.db, key);
      if (existing) {
        const card = await this.ledger.getCard(uow.db, existing.id);
        return toIntentDto(existing, card);
      }
      const account = await uow.db.maybeOne<ProviderAccountRow>(
        'SELECT * FROM payments.payment_provider_accounts WHERE tenant_id = $1 AND id = $2',
        [uow.tenantId, input.providerAccountId],
      );
      const terminal = await uow.db.maybeOne<
        TerminalRow & {
          account_capabilities: ProviderAccountRow['capabilities'];
          account_settings: ProviderAccountRow['settings'];
          account_provider: string;
        }
      >(
        `SELECT t.*, a.provider AS account_provider, a.capabilities AS account_capabilities, a.settings AS account_settings
           FROM payments.payment_terminals t
           JOIN payments.payment_provider_accounts a ON a.tenant_id = t.tenant_id AND a.id = t.provider_account_id
          WHERE t.tenant_id = $1 AND t.id = $2 AND t.provider_account_id = $3`,
        [uow.tenantId, input.terminalId, input.providerAccountId],
      );
      if (!account || !terminal) throw new NotFoundError();

      const amount = BigInt(input.amountMinor);
      const tip = BigInt(input.tipMinor ?? '0');
      const collectedAt = new Date(input.collectedAt);
      const windowHours = account.settings?.offline?.windowHours ?? this.config.offlineWindowHours;
      const expiresAt = input.expiresAt
        ? new Date(input.expiresAt)
        : new Date(collectedAt.getTime() + windowHours * 3_600_000);

      const id = newId();
      const inserted = await uow.db.query<IntentRow>(
        `INSERT INTO payments.payment_intents
           (id, tenant_id, location_id, order_id, check_id, idempotency_key, method, amount_minor, tip_minor, currency,
            settlement_status, provider_account_id, terminal_id, device_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'card_present', $7, $8, $9, 'unsettled', $10, $11, $12, $13) RETURNING *`,
        [
          id,
          uow.tenantId,
          input.locationId,
          input.orderId,
          input.checkId,
          key,
          amount,
          tip,
          check.currency,
          account.id,
          terminal.id,
          input.deviceId ?? caller.deviceId ?? null,
          caller.actorUserId ?? null,
        ],
      );
      await this.ledger.insertEvent(uow.db, id, caller, {
        kind: 'created',
        to: 'created',
        amountMinor: amount,
        payload: { method: 'card_present', offline: true },
      });
      let intent = await this.ledger.transition(
        uow,
        inserted[0]!,
        'processing',
        { ...caller, source: 'terminal' },
        {
          kind: 'submitted',
          amountMinor: amount,
          payload: { offline: true },
        },
      );
      intent = await this.ledger.transition(
        uow,
        intent,
        'captured',
        { ...caller, source: 'terminal' },
        {
          kind: 'captured',
          amountMinor: amount + tip,
          occurredAt: collectedAt,
          payload: { offline: true, forwardOutcome: 'pending', deviceSeq: input.deviceSeq ?? null },
        },
        {
          capturedMinor: amount + tip,
          authorizedMinor: amount + tip,
          offline: true,
          settlementPending: true,
          offlineCollectedAt: collectedAt,
          offlineExpiresAt: expiresAt,
          offlineDeviceSeq: input.deviceSeq ?? null,
          forwardOutcome: 'pending',
        },
      );
      if (input.card) {
        await this.ledger.saveCardDetails(uow.db, id, {
          cardBrand: input.card.cardBrand,
          last4: input.card.last4,
          entryMode: input.card.entryMode,
          authCode: input.card.authCode,
          aid: input.card.aid,
          applicationLabel: input.card.applicationLabel,
          terminalReceiptText: input.card.terminalReceiptText,
        });
      }
      await this.ledger.syncOrder(uow, intent);
      this.ledger.emit(uow, 'payment.captured', intent, {
        offline: true,
        forwardOutcome: 'pending',
      });
      await this.checkOfflineCaps(uow, intent, account, terminal, amount + tip);
      uow.audit({
        action: 'payments.offline.recorded',
        resourceKind: 'payment_intent',
        resourceId: id,
        locationId: input.locationId,
        deviceId: input.deviceId ?? null,
        after: { amountMinor: (amount + tip).toString(), expiresAt: expiresAt.toISOString() },
      });
      const card = await this.ledger.getCard(uow.db, id);
      return toIntentDto(intent, card);
    });
  }

  /** Detect, after the fact, a sale outside what the tenant allowed offline (caps are enforced at the Edge and proven here). */
  async checkOfflineCaps(
    uow: TenantUnitOfWork,
    intent: IntentRow,
    account: ProviderAccountRow,
    terminal: TerminalRow & {
      account_capabilities: ProviderAccountRow['capabilities'];
      account_settings: ProviderAccountRow['settings'];
    },
    amount: bigint,
  ): Promise<void> {
    const reasons: string[] = [];
    const offline = account.settings?.offline ?? {};
    if (!terminalOfflineCapable({ ...terminal, account_provider: account.provider }))
      reasons.push('connection_mode_not_offline_capable');
    if (offline.maxTransactionMinor !== undefined && amount > BigInt(offline.maxTransactionMinor))
      reasons.push('per_transaction_cap');
    if (
      intent.device_id &&
      (offline.maxCountPerDevice !== undefined || offline.maxSumPerDeviceMinor !== undefined)
    ) {
      const open = await uow.db.one<{ n: bigint; s: bigint }>(
        `SELECT COUNT(*)::bigint AS n, COALESCE(SUM(captured_minor), 0)::bigint AS s
           FROM payments.payment_intents
          WHERE tenant_id = $1 AND device_id = $2 AND offline AND forward_outcome IN ('pending','rescue_in_progress')`,
        [uow.tenantId, intent.device_id],
      );
      if (offline.maxCountPerDevice !== undefined && open.n > BigInt(offline.maxCountPerDevice))
        reasons.push('device_count_cap');
      if (
        offline.maxSumPerDeviceMinor !== undefined &&
        open.s > BigInt(offline.maxSumPerDeviceMinor)
      )
        reasons.push('device_sum_cap');
    }
    if (reasons.length === 0) return;
    await this.ledger.raiseException(uow.db, {
      kind: 'offline_cap_exceeded',
      severity: 'high',
      subjectKind: 'payment_intent',
      subjectId: intent.id,
      details: { reasons, amountMinor: amount.toString(), deviceId: intent.device_id },
    });
  }

  /** The Payments Edge reports what happened when it forwarded a stored payment. */
  async recordForwardOutcome(
    intentId: string,
    input: ForwardOutcomeRequest,
  ): Promise<PaymentIntentDto> {
    const { tenantId, actor, caller } = this.runner.request();
    return this.runner.run(tenantId, actor, async (uow) => {
      const intent = await this.ledger.lockIntent(uow.db, intentId);
      if (!intent) throw new NotFoundError();
      await this.authz.assert(PAYMENT_PERMISSIONS.take, {
        kind: 'location',
        id: intent.location_id,
      });
      if (!intent.offline || intent.forward_outcome === null)
        throw new ConflictError(
          'NOT_OFFLINE',
          'Only an offline-collected payment has a forward outcome',
        );
      const forwardedAt = input.forwardedAt ? new Date(input.forwardedAt) : new Date();
      if (intent.forward_outcome === input.outcome) {
        return toIntentDto(intent, await this.ledger.getCard(uow.db, intent.id));
      }
      if (intent.forward_outcome !== 'pending' && intent.forward_outcome !== 'rescue_in_progress')
        throw new ConflictError(
          'FORWARD_OUTCOME_FINAL',
          `The forward outcome is already ${intent.forward_outcome}`,
        );
      let updated: IntentRow;
      if (input.outcome === 'approved') {
        updated = await this.ledger.annotate(
          uow,
          intent,
          caller,
          {
            kind: 'forward_approved',
            amountMinor: intent.captured_minor,
            occurredAt: forwardedAt,
            payload: { providerReference: input.providerReference ?? null },
          },
          {
            forwardOutcome: 'approved',
            forwardedAt,
            settlementPending: false,
            ...(input.providerReference ? { providerReference: input.providerReference } : {}),
          },
        );
        await this.ledger.syncOrder(uow, updated);
      } else if (input.outcome === 'rescue_in_progress') {
        updated = await this.ledger.annotate(
          uow,
          intent,
          caller,
          {
            kind: 'forward_rescue',
            occurredAt: forwardedAt,
            payload: { declineCode: input.declineCode ?? null },
          },
          {
            forwardOutcome: 'rescue_in_progress',
            forwardedAt,
            ...(input.expiresAt ? { offlineExpiresAt: new Date(input.expiresAt) } : {}),
          },
        );
      } else {
        updated = await this.failOffline(uow, intent, 'declined', caller, {
          forwardedAt,
          declineCode: input.declineCode ?? null,
        });
      }
      uow.audit({
        action: `payments.offline.forward_${input.outcome}`,
        resourceKind: 'payment_intent',
        resourceId: intent.id,
        locationId: intent.location_id,
        after: { outcome: input.outcome },
      });
      return toIntentDto(updated, await this.ledger.getCard(uow.db, intent.id));
    });
  }

  /**
   * An offline sale was declined by the issuer after forwarding, or its window expired (docs/01
   * §8.3): the intent fails, the check reopens, an exception lands in the manager's queue.
   * Used by the forward-outcome route and by the expiry sweeper.
   */
  async failOffline(
    uow: TenantUnitOfWork,
    intent: IntentRow,
    outcome: 'declined' | 'expired',
    caller: Caller,
    detail: { forwardedAt?: Date; declineCode?: string | null } = {},
  ): Promise<IntentRow> {
    if (intent.refunded_minor > 0n)
      throw new ConflictError(
        'OFFLINE_ALREADY_REFUNDED',
        'An offline payment cannot fail after a refund',
      );
    const updated = await this.ledger.transition(
      uow,
      intent,
      'failed',
      caller,
      {
        kind: outcome === 'declined' ? 'offline_declined' : 'offline_expired',
        amountMinor: intent.captured_minor,
        payload: { declineCode: detail.declineCode ?? null, forwardOutcome: outcome },
      },
      {
        capturedMinor: 0n,
        authorizedMinor: 0n,
        forwardOutcome: outcome,
        settlementPending: false,
        ...(detail.forwardedAt ? { forwardedAt: detail.forwardedAt } : {}),
        lastError: { code: `offline_${outcome}`, declineCode: detail.declineCode ?? null },
      },
      { offlineForwardFailed: true },
    );
    await this.orders.reopenForOfflineFailure(uow, {
      orderId: intent.order_id,
      checkId: intent.check_id,
      intentId: intent.id,
      reason: outcome === 'declined' ? 'offline_payment_declined' : 'offline_payment_expired',
    });
    await this.ledger.syncOrder(uow, updated);
    await this.ledger.raiseException(uow.db, {
      kind: outcome === 'declined' ? 'offline_declined' : 'offline_expired',
      severity: 'high',
      subjectKind: 'payment_intent',
      subjectId: intent.id,
      details: {
        orderId: intent.order_id,
        checkId: intent.check_id,
        amountMinor: intent.captured_minor.toString(),
        offlineExpiresAt: intent.offline_expires_at?.toISOString() ?? null,
        declineCode: detail.declineCode ?? null,
      },
    });
    this.ledger.emit(uow, 'payment.failed', updated, { offline: true, forwardOutcome: outcome });
    return updated;
  }

  // --- reads -----------------------------------------------------------------------------------

  async get(id: string): Promise<PaymentIntentDto> {
    const { intent, card } = await this.uow.read(async (db) => ({
      intent: await this.ledger.getIntent(db, id),
      card: await this.ledger.getCard(db, id),
    }));
    if (!intent) throw new NotFoundError();
    await this.authz.assert(PAYMENT_PERMISSIONS.view, { kind: 'location', id: intent.location_id });
    return toIntentDto(intent, card);
  }

  async events(id: string): Promise<PaymentEventDto[]> {
    await this.get(id);
    const rows = await this.uow.read((db) =>
      db.query<EventRow>(
        'SELECT * FROM payments.payment_events WHERE tenant_id = $1 AND intent_id = $2 ORDER BY occurred_at, recorded_at, id',
        [db.tenantId, id],
      ),
    );
    return rows.map(toEventDto);
  }

  async attempts(id: string): Promise<PaymentAttemptDto[]> {
    await this.get(id);
    const rows = await this.uow.read((db) =>
      db.query<AttemptRow>(
        'SELECT * FROM payments.payment_attempts WHERE tenant_id = $1 AND intent_id = $2 ORDER BY attempt_no, started_at',
        [db.tenantId, id],
      ),
    );
    return rows.map(toAttemptDto);
  }

  async list(query: PaymentIntentListQuery): Promise<Page<PaymentIntentDto>> {
    this.authz.assertAnywhere(PAYMENT_PERMISSIONS.view);
    const principal = this.context.require().principal!;
    const rows = await this.uow.read((db) => {
      const params: unknown[] = [db.tenantId];
      const where = ['i.tenant_id = $1'];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replace('?', `$${params.length}`));
      };
      if (query.orderId) add('i.order_id = ?', query.orderId);
      if (query.checkId) add('i.check_id = ?', query.checkId);
      if (query.locationId) add('i.location_id = ?', query.locationId);
      if (query.status) add('i.status = ?', query.status);
      if (query.offlineOpen === 'true')
        where.push("i.offline AND i.forward_outcome IN ('pending','rescue_in_progress')");
      if (query.cursor) add('i.id > ?', query.cursor);
      return db.query<IntentRow & { ancestor_ids: string[] }>(
        `SELECT i.*, COALESCE(array_agg(p.ancestor_id ORDER BY p.depth) FILTER (WHERE p.ancestor_id IS NOT NULL), '{}') AS ancestor_ids
           FROM payments.payment_intents i
           JOIN tenancy.locations l ON l.tenant_id = i.tenant_id AND l.id = i.location_id
           LEFT JOIN tenancy.org_unit_paths p ON p.tenant_id = l.tenant_id AND p.descendant_id = l.org_unit_id
          WHERE ${where.join(' AND ')}
          GROUP BY i.id
          ORDER BY i.id
          LIMIT ${query.limit + 1}`,
        params,
      );
    });
    const page = rows.slice(0, query.limit);
    const reachable = page.filter(
      (r) =>
        isOperator(principal) ||
        principalReaches(principal, {
          kind: 'location',
          id: r.location_id,
          path: [
            { kind: 'location', id: r.location_id },
            ...r.ancestor_ids.map((id) => ({ kind: 'org_unit' as const, id })),
          ],
        }),
    );
    return {
      items: reachable.map((r) => toIntentDto(r, null)),
      nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /** Check summary for the future PaymentsPort consumers: what is collected and what is still owed. */
  async checkSummary(db: TenantScopedDb, checkId: string) {
    const check = await this.orders.getCheck(db, checkId);
    if (!check) return null;
    const collected = await this.committedAmount(db, checkId, [
      'captured',
      'partially_refunded',
      'refunded',
    ]);
    return {
      checkId,
      totalMinor: check.totalMinor,
      collectedMinor: collected,
      outstandingMinor: check.totalMinor - collected,
      paid: collected >= check.totalMinor && check.totalMinor > 0n,
    };
  }

  // --- helpers ---------------------------------------------------------------------------------

  private idempotencyKey(deviceId: string | undefined, clientIntentId: string): string {
    const caller = this.context.require().principal;
    const scope =
      deviceId ??
      (caller && !isOperator(caller) ? (caller.deviceId ?? caller.subjectId) : 'operator');
    return `${scope}:${clientIntentId}`;
  }

  private async byKey(db: TenantScopedDb, key: string): Promise<IntentRow | null> {
    return db.maybeOne<IntentRow>(
      'SELECT * FROM payments.payment_intents WHERE tenant_id = $1 AND idempotency_key = $2',
      [db.tenantId, key],
    );
  }

  private async replay(
    db: TenantScopedDb,
    existing: IntentRow,
    input: CreatePaymentIntent,
  ): Promise<PaymentIntentDto> {
    if (
      existing.check_id !== input.checkId ||
      existing.amount_minor !== BigInt(input.amountMinor) ||
      existing.method !== input.method
    )
      throw new ValidationError(
        { clientIntentId: 'reused with a different check, amount or method' },
        'clientIntentId was already used for a different payment',
      );
    return toIntentDto(existing, await this.ledger.getCard(db, existing.id));
  }

  private async requirePayableCheck(
    uow: TenantUnitOfWork,
    locationId: string,
    orderId: string,
    checkId: string,
    lock = false,
  ): Promise<CheckForPayment> {
    const check = await this.orders.getCheck(uow.db, checkId, { lock });
    if (!check || check.orderId !== orderId || check.locationId !== locationId)
      throw new NotFoundError();
    if (['voided', 'cancelled'].includes(check.orderStatus) || check.checkStatus === 'voided')
      throw new ConflictError('ORDER_NOT_PAYABLE', `The order is ${check.orderStatus}`);
    return check;
  }

  /** Σ amount of intents that hold or will hold money against the check (default: all in-flight and collected states). */
  private async committedAmount(
    db: TenantScopedDb,
    checkId: string,
    statuses: readonly string[] = [
      'processing',
      'authorized',
      'uncertain',
      'captured',
      'partially_refunded',
      'refunded',
    ],
  ): Promise<bigint> {
    const rows = await db.query<{
      status: IntentRow['status'];
      amount_minor: bigint;
      captured_minor: bigint;
      refunded_minor: bigint;
    }>(
      `SELECT status, amount_minor, captured_minor, refunded_minor FROM payments.payment_intents
        WHERE tenant_id = $1 AND check_id = $2 AND status = ANY($3::text[])`,
      [db.tenantId, checkId, statuses],
    );
    let inFlight = 0n;
    const collected: { capturedMinor: bigint; refundedMinor: bigint }[] = [];
    for (const r of rows) {
      if ((IN_FLIGHT as readonly string[]).includes(r.status)) inFlight += r.amount_minor;
      else collected.push({ capturedMinor: r.captured_minor, refundedMinor: r.refunded_minor });
    }
    return inFlight + netCollected(collected);
  }

  private async assertWithinOutstanding(
    db: TenantScopedDb,
    check: CheckForPayment,
    amount: bigint,
  ): Promise<void> {
    const committed = await this.committedAmount(db, check.checkId);
    if (amount > check.totalMinor - committed)
      throw new ConflictError(
        'AMOUNT_EXCEEDS_OUTSTANDING',
        'Amount exceeds what is still owed on the check',
      );
  }

  private async pickAccount(
    db: TenantScopedDb,
    input: CreatePaymentIntent,
    currency: string,
  ): Promise<ProviderAccountRow> {
    let account: ProviderAccountRow | null = null;
    if (input.providerAccountId) {
      account = await db.maybeOne<ProviderAccountRow>(
        'SELECT * FROM payments.payment_provider_accounts WHERE tenant_id = $1 AND id = $2',
        [db.tenantId, input.providerAccountId],
      );
      if (!account) throw new NotFoundError();
    } else if (input.terminalId) {
      account = await db.maybeOne<ProviderAccountRow>(
        `SELECT a.* FROM payments.payment_provider_accounts a
           JOIN payments.payment_terminals t ON t.tenant_id = a.tenant_id AND t.provider_account_id = a.id
          WHERE t.tenant_id = $1 AND t.id = $2`,
        [db.tenantId, input.terminalId],
      );
      if (!account) throw new NotFoundError();
    } else {
      account = await db.maybeOne<ProviderAccountRow>(
        `SELECT * FROM payments.payment_provider_accounts
          WHERE tenant_id = $1 AND status = 'active' AND $2 = ANY(currencies)
            AND (scope_kind = 'tenant' OR (scope_kind = 'location' AND scope_id = $3))
          ORDER BY (scope_kind = 'location') DESC, created_at LIMIT 1`,
        [db.tenantId, currency, input.locationId],
      );
      if (!account)
        throw new ConflictError(
          'NO_PROVIDER_ACCOUNT',
          'No active provider account takes this currency here',
        );
    }
    if (account.status !== 'active')
      throw new ConflictError('PROVIDER_ACCOUNT_INACTIVE', 'The provider account is not active');
    if (!account.currencies.map((c) => c.trim()).includes(currency))
      throw new ConflictError(
        'CURRENCY_NOT_SUPPORTED',
        `The provider account does not take ${currency}`,
      );
    return account;
  }

  private async requireTerminal(
    db: TenantScopedDb,
    input: CreatePaymentIntent,
    account: ProviderAccountRow,
  ): Promise<TerminalRow> {
    const terminal = await db.maybeOne<TerminalRow>(
      'SELECT * FROM payments.payment_terminals WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, input.terminalId],
    );
    if (!terminal || terminal.location_id !== input.locationId) throw new NotFoundError();
    if (terminal.provider_account_id !== account.id)
      throw new ConflictError(
        'TERMINAL_ACCOUNT_MISMATCH',
        'The terminal belongs to a different provider account',
      );
    if (terminal.status !== 'paired')
      throw new ConflictError('TERMINAL_NOT_PAIRED', `The terminal is ${terminal.status}`);
    return terminal;
  }
}
