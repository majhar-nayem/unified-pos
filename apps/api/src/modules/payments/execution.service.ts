import { Inject, Injectable } from '@nestjs/common';
import {
  type CaptureIntent,
  PAYMENT_PERMISSIONS,
  type PaymentIntentDto,
  type SubmitIntent,
} from '@pos/contracts';
import type { TenantUnitOfWork } from '@pos/db';
import type { Money } from '@pos/domain-core';
import {
  type IdempotencyKey,
  type MaskedCard,
  type PaymentProviderAdapter,
  type ProviderRef,
  type ProviderResult,
  type ProviderStatus,
  type TerminalEvent,
  type TerminalInfo,
  idempotencyKey,
} from '@pos/payments-sdk';

import { AuthorizationService, ConflictError, NotFoundError } from '../kernel/public/index.js';
import { IntentsService } from './intents.service.js';
import { type Caller, PaymentsLedger } from './ledger.service.js';
import { PAYMENTS_CONFIG, type PaymentsConfig } from './payments.config.js';
import { PaymentsRunner } from './payments-runner.js';
import { PROVIDER_REGISTRY, ProviderRegistry } from './providers/provider-registry.js';
import {
  type AttemptRow,
  type IntentRow,
  type ProviderAccountRow,
  chargeTotal,
  toIntentDto,
} from './rows.js';
import { TerminalsService, terminalOfflineCapable } from './terminals.service.js';

type TerminalRowWithAccount = NonNullable<Awaited<ReturnType<TerminalsService['load']>>>;

/** Test seam: fault injection between the provider call and settling its result (a simulated crash). */
export interface ExecutionFaults {
  afterProviderCall?: (intent: IntentRow) => void | Promise<void>;
}
export const EXECUTION_FAULTS = Symbol('EXECUTION_FAULTS');

type ChargeOutcome =
  | { kind: 'result'; result: ProviderResult; offline: boolean; receiptText?: string | undefined }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' };

interface SubmitPlan {
  readonly intent: IntentRow;
  readonly attempt: AttemptRow;
  readonly account: ProviderAccountRow;
  readonly adapter: PaymentProviderAdapter;
  readonly terminal: TerminalRowWithAccount | null;
  readonly idem: IdempotencyKey;
  readonly captureMode: 'auto' | 'manual';
  readonly allowOffline: boolean;
}

type Operation = 'capture' | 'cancel' | 'reverse';

const money = (amountMinor: bigint, currency: string): Money => ({
  amountMinor,
  currency: currency.trim(),
});

const terminalInfo = (t: TerminalRowWithAccount): TerminalInfo => ({
  id: t.id,
  provider: t.account_provider as TerminalInfo['provider'],
  serialNumber: t.serial_number,
  connectionMode: t.connection_mode,
  address: t.address,
  pairingRef: t.pairing_ref,
});

/**
 * Everything that talks to a provider. The shape is always: prepare (one transaction: validate,
 * move the intent, write an attempt with a stable provider idempotency key) → call the provider
 * OUTSIDE any transaction → settle (a second transaction applies the result). A crash between the
 * two leaves a `processing` intent with a `started` attempt, which the stuck-payment sweeper
 * resolves with the same idempotency key or `getStatus`, so an acknowledged payment is never
 * lost and an internal retry never charges twice.
 */
@Injectable()
export class ExecutionService {
  constructor(
    private readonly authz: AuthorizationService,
    private readonly runner: PaymentsRunner,
    private readonly ledger: PaymentsLedger,
    private readonly intents: IntentsService,
    private readonly terminals: TerminalsService,
    @Inject(PROVIDER_REGISTRY) private readonly registry: ProviderRegistry,
    @Inject(PAYMENTS_CONFIG) private readonly config: PaymentsConfig,
    @Inject(EXECUTION_FAULTS) private readonly faults: ExecutionFaults,
  ) {}

  // --- submit ----------------------------------------------------------------------------------

  async submit(intentId: string, input: SubmitIntent = {}): Promise<PaymentIntentDto> {
    const { tenantId, actor, caller } = this.runner.request();
    const prepared = await this.runner.run(tenantId, actor, async (uow) => {
      const intent = await this.ledger.lockIntent(uow.db, intentId);
      if (!intent) throw new NotFoundError();
      await this.authz.assert(PAYMENT_PERMISSIONS.take, {
        kind: 'location',
        id: intent.location_id,
      });
      if (intent.status !== 'created') {
        // Re-submitting never reaches the provider again: the sweeper owns processing/uncertain.
        return {
          kind: 'noop' as const,
          intent,
          card: await this.ledger.getCard(uow.db, intent.id),
        };
      }
      if (!intent.provider_account_id)
        throw new ConflictError('NO_PROVIDER_ACCOUNT', 'The intent has no provider account');
      const account = await uow.db.one<ProviderAccountRow>(
        'SELECT * FROM payments.payment_provider_accounts WHERE tenant_id = $1 AND id = $2',
        [uow.tenantId, intent.provider_account_id],
      );
      const adapter = this.registry.adapter(account.provider);
      const terminal = intent.terminal_id
        ? await this.terminals.load(uow.db, intent.terminal_id)
        : null;
      if (terminal && !this.registry.terminal(account.provider))
        throw new ConflictError(
          'TERMINAL_ADAPTER_UNAVAILABLE',
          'No terminal adapter for this provider',
        );
      const captureMode = account.settings?.captureMode ?? 'auto';
      const operation = captureMode === 'auto' ? 'sale' : 'auth';
      const idem = idempotencyKey(`${intent.id}:${operation}`);
      const allowOffline =
        input.allowOffline === true &&
        terminal !== null &&
        account.settings?.offline?.enabled !== false &&
        terminalOfflineCapable(terminal);
      const processing = await this.ledger.transition(uow, intent, 'processing', caller, {
        kind: 'submitted',
        amountMinor: chargeTotal(intent),
        payload: { operation, terminalId: terminal?.id ?? null, allowOffline },
      });
      const attempt = await this.ledger.startAttempt(uow.db, intent.id, {
        operation,
        providerIdempotencyKey: idem,
        request: this.requestPayload(processing, captureMode, terminal?.id ?? null),
      });
      const plan: SubmitPlan = {
        intent: processing,
        attempt,
        account,
        adapter,
        terminal,
        idem,
        captureMode,
        allowOffline,
      };
      return { kind: 'go' as const, plan };
    });
    if (prepared.kind === 'noop') return toIntentDto(prepared.intent, prepared.card);

    const outcome = await this.charge(prepared.plan);
    await this.faults.afterProviderCall?.(prepared.plan.intent);
    return this.runner.run(tenantId, actor, (uow) =>
      this.settleCharge(uow, prepared.plan, outcome, caller),
    );
  }

  private requestPayload(intent: IntentRow, captureMode: string, terminalId: string | null) {
    return {
      amountMinor: chargeTotal(intent).toString(),
      currency: intent.currency.trim(),
      capture: captureMode,
      reference: intent.id,
      terminalId,
      metadata: { tenantId: intent.tenant_id, intentId: intent.id },
    };
  }

  private async charge(plan: SubmitPlan): Promise<ChargeOutcome> {
    const { intent, account, adapter, terminal } = plan;
    try {
      if (terminal) {
        const terminalAdapter = this.registry.terminal(account.provider)!;
        let final: ChargeOutcome | null = null;
        const events: AsyncIterable<TerminalEvent> = terminalAdapter.startTransaction(
          { terminal: terminalInfo(terminal), sessionId: intent.id },
          {
            intentId: intent.id,
            amount: money(intent.amount_minor, intent.currency),
            ...(intent.tip_minor > 0n ? { tip: money(intent.tip_minor, intent.currency) } : {}),
            capture: plan.captureMode,
            reference: intent.id,
            allowOffline: plan.allowOffline,
          },
        );
        for await (const event of events) {
          if (event.kind === 'result')
            final = {
              kind: 'result',
              result: event.result,
              offline: event.offline,
              receiptText: event.receiptText,
            };
          else if (event.kind === 'cancelled') final = { kind: 'cancelled' };
        }
        return final ?? { kind: 'error', message: 'Terminal stream ended without a result' };
      }
      const result = await adapter.createPayment(
        {
          account: {
            id: account.id,
            provider: adapter.key,
            currency: intent.currency.trim(),
            credentialsRef: account.credentials_ref,
          },
          amount: money(chargeTotal(intent), intent.currency),
          intentId: intent.id,
          capture: plan.captureMode,
          reference: intent.id,
          metadata: { tenantId: intent.tenant_id, intentId: intent.id },
        },
        plan.idem,
      );
      return { kind: 'result', result, offline: false };
    } catch (error) {
      // Any exception means the outcome is UNKNOWN, never "declined": the provider may have charged.
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async settleCharge(
    uow: TenantUnitOfWork,
    plan: SubmitPlan,
    outcome: ChargeOutcome,
    caller: Caller,
  ): Promise<PaymentIntentDto> {
    const current = await this.ledger.lockIntent(uow.db, plan.intent.id);
    if (!current) throw new NotFoundError();
    // The sweeper (or a webhook) may have resolved it while the provider call was slow; a certain
    // answer still applies to `uncertain`, anything else is already settled.
    if (current.status !== 'processing' && current.status !== 'uncertain')
      return toIntentDto(current, await this.ledger.getCard(uow.db, current.id));

    const actingCaller: Caller = plan.terminal ? { ...caller, source: 'terminal' } : caller;
    let updated: IntentRow;
    if (outcome.kind === 'result' && outcome.result.outcome === 'approved') {
      await this.ledger.finishAttempt(uow.db, plan.attempt.id, {
        status: 'succeeded',
        response: outcome.result,
        providerRequestId: outcome.result.ref.providerPaymentId,
      });
      updated = await this.applyApproved(uow, current, actingCaller, {
        amount: outcome.result.amount.amountMinor,
        ref: outcome.offline ? null : outcome.result.ref,
        masked: outcome.result.masked,
        authCode: outcome.result.authCode,
        captureMode: plan.captureMode,
        offline: outcome.offline,
        receiptText: outcome.receiptText,
        account: plan.account,
        terminal: plan.terminal,
        eventKind: plan.captureMode === 'auto' ? 'captured' : 'authorized',
      });
    } else if (outcome.kind === 'result' && outcome.result.outcome === 'declined') {
      await this.ledger.finishAttempt(uow.db, plan.attempt.id, {
        status: 'declined',
        response: outcome.result,
        errorCode: outcome.result.code,
        errorMessage: outcome.result.message,
      });
      updated = await this.applyDeclined(
        uow,
        current,
        actingCaller,
        outcome.result.code,
        outcome.result.message,
        outcome.result.ref ?? null,
        'declined',
      );
    } else if (outcome.kind === 'cancelled') {
      await this.ledger.finishAttempt(uow.db, plan.attempt.id, {
        status: 'error',
        errorCode: 'terminal_cancelled',
        errorMessage: 'Cancelled at the terminal',
      });
      updated = await this.applyDeclined(
        uow,
        current,
        actingCaller,
        'terminal_cancelled',
        'Cancelled at the terminal',
        null,
        'cancelled',
      );
    } else {
      const ref =
        outcome.kind === 'result' && outcome.result.outcome === 'uncertain'
          ? (outcome.result.ref ?? null)
          : null;
      const reason =
        outcome.kind === 'result' && outcome.result.outcome === 'uncertain'
          ? outcome.result.reason
          : outcome.kind === 'error'
            ? outcome.message
            : 'unknown';
      await this.ledger.finishAttempt(uow.db, plan.attempt.id, {
        status: 'timeout',
        response: outcome.kind === 'result' ? outcome.result : undefined,
        errorCode: 'uncertain',
        errorMessage: reason,
      });
      const patch = ref ? { providerReference: ref.providerPaymentId } : {};
      updated =
        current.status === 'uncertain'
          ? await this.ledger.annotate(
              uow,
              current,
              actingCaller,
              { kind: 'timeout', payload: { reason } },
              patch,
            )
          : await this.ledger.transition(
              uow,
              current,
              'uncertain',
              actingCaller,
              { kind: 'timeout', payload: { reason } },
              patch,
            );
    }
    return toIntentDto(updated, await this.ledger.getCard(uow.db, updated.id));
  }

  // --- shared result application --------------------------------------------------------------

  private async applyApproved(
    uow: TenantUnitOfWork,
    intent: IntentRow,
    caller: Caller,
    input: {
      amount: bigint;
      ref: ProviderRef | null;
      masked?: MaskedCard | undefined;
      authCode?: string | undefined;
      captureMode: 'auto' | 'manual';
      offline: boolean;
      receiptText?: string | undefined;
      account: ProviderAccountRow;
      terminal: TerminalRowWithAccount | null;
      eventKind: string;
      payload?: Record<string, unknown>;
    },
  ): Promise<IntentRow> {
    const total = chargeTotal(intent);
    let amount = input.amount;
    if (amount > total) {
      await this.ledger.raiseException(uow.db, {
        kind: 'amount_mismatch',
        severity: 'high',
        subjectKind: 'payment_intent',
        subjectId: intent.id,
        details: {
          requestedMinor: total.toString(),
          providerMinor: amount.toString(),
          source: 'approval',
        },
      });
      amount = total;
    }
    const now = new Date();
    const captured = input.captureMode === 'auto';
    const offlinePatch = input.offline
      ? {
          offline: true,
          settlementPending: true,
          offlineCollectedAt: now,
          offlineExpiresAt: new Date(
            now.getTime() +
              (input.account.settings?.offline?.windowHours ?? this.config.offlineWindowHours) *
                3_600_000,
          ),
          forwardOutcome: 'pending' as const,
        }
      : {};
    const updated = await this.ledger.transition(
      uow,
      intent,
      captured ? 'captured' : 'authorized',
      caller,
      {
        kind: input.eventKind,
        amountMinor: amount,
        payload: {
          offline: input.offline,
          authCode: input.authCode ?? null,
          ...(input.payload ?? {}),
        },
      },
      {
        authorizedMinor: amount,
        ...(captured ? { capturedMinor: amount } : {}),
        ...(input.ref ? { providerReference: input.ref.providerPaymentId } : {}),
        ...offlinePatch,
      },
    );
    if (input.masked || input.authCode || input.receiptText) {
      await this.ledger.saveCardDetails(uow.db, intent.id, {
        cardBrand: input.masked?.scheme,
        last4: input.masked?.last4,
        entryMode: input.masked?.entryMode,
        authCode: input.authCode,
        aid: input.masked?.aid,
        applicationLabel: input.masked?.applicationLabel,
        tokenRef: input.masked?.tokenRef,
        schemeReference: input.masked?.schemeReference,
        cardholderVerification: input.masked?.cardholderVerification,
        issuerBank: input.masked?.issuerBank,
        terminalReceiptText: input.receiptText ?? input.masked?.terminalReceiptText,
      });
    }
    if (captured) await this.ledger.syncOrder(uow, updated);
    this.ledger.emit(uow, captured ? 'payment.captured' : 'payment.authorized', updated, {
      ...(input.offline ? { offline: true, forwardOutcome: 'pending' } : {}),
    });
    if (input.offline && input.terminal)
      await this.intents.checkOfflineCaps(uow, updated, input.account, input.terminal, amount);
    return updated;
  }

  private async applyDeclined(
    uow: TenantUnitOfWork,
    intent: IntentRow,
    caller: Caller,
    code: string,
    message: string,
    ref: ProviderRef | null,
    eventKind: 'declined' | 'cancelled',
  ): Promise<IntentRow> {
    const updated = await this.ledger.transition(
      uow,
      intent,
      'failed',
      caller,
      { kind: eventKind, payload: { code, message } },
      {
        lastError: { code, message },
        ...(ref ? { providerReference: ref.providerPaymentId } : {}),
      },
    );
    this.ledger.emit(uow, 'payment.failed', updated, { code });
    return updated;
  }

  // --- uncertain resolution (docs/01 §7.3: query the provider before any retry) -----------------

  /**
   * Resolve an `uncertain` intent by asking the provider. With a provider reference that is
   * `getStatus`; with none (we never saw an answer) it is the provider's own idempotent replay of
   * the original request under the SAME key, which returns the original outcome and cannot charge
   * twice. A new intent with a new key is only ever created by the client after `failed`.
   */
  async resolveUncertain(tenantId: string, intentId: string): Promise<IntentRow['status'] | null> {
    const prep = await this.runner.system(tenantId, async (uow) => {
      const intent = await this.ledger.getIntent(uow.db, intentId);
      if (!intent || intent.status !== 'uncertain' || !intent.provider_account_id) return null;
      const account = await uow.db.one<ProviderAccountRow>(
        'SELECT * FROM payments.payment_provider_accounts WHERE tenant_id = $1 AND id = $2',
        [uow.tenantId, intent.provider_account_id],
      );
      const adapter = this.registry.find(account.provider);
      if (!adapter) return null;
      const terminal = intent.terminal_id
        ? await this.terminals.load(uow.db, intent.terminal_id)
        : null;
      const captureMode = account.settings?.captureMode ?? 'auto';
      const idem = idempotencyKey(`${intent.id}:${captureMode === 'auto' ? 'sale' : 'auth'}`);
      const attempt = await this.ledger.startAttempt(uow.db, intent.id, {
        operation: 'status_query',
        providerIdempotencyKey: intent.provider_reference ? null : idem,
        request: {
          providerReference: intent.provider_reference,
          via: intent.provider_reference
            ? 'getStatus'
            : terminal
              ? 'terminal'
              : 'idempotent_replay',
        },
      });
      return { intent, account, adapter, terminal, captureMode, idem, attempt };
    });
    if (!prep) return null;
    const { intent, account, adapter, terminal, captureMode, idem, attempt } = prep;

    let observed: ProviderStatus = { state: 'unknown' };
    let ref: ProviderRef | null = intent.provider_reference
      ? { provider: adapter.key, providerPaymentId: intent.provider_reference }
      : null;
    let failure: string | null = null;
    try {
      const terminalAdapter = terminal ? this.registry.terminal(account.provider) : null;
      if (ref) {
        observed = await adapter.getStatus(ref);
      } else if (terminal && terminalAdapter) {
        const last = await terminalAdapter.lastTransactionResult(terminalInfo(terminal));
        // The terminal's last transaction only counts when it is for exactly this charge.
        if (last.state !== 'unknown' && last.amount.amountMinor === chargeTotal(intent))
          observed = last;
      } else {
        const replay = await adapter.createPayment(
          {
            account: {
              id: account.id,
              provider: adapter.key,
              currency: intent.currency.trim(),
              credentialsRef: account.credentials_ref,
            },
            amount: money(chargeTotal(intent), intent.currency),
            intentId: intent.id,
            capture: captureMode,
            reference: intent.id,
            metadata: { tenantId: intent.tenant_id, intentId: intent.id },
          },
          idem,
        );
        if (replay.outcome === 'approved') {
          ref = replay.ref;
          observed = {
            state: captureMode === 'auto' ? 'captured' : 'authorized',
            amount: replay.amount,
          };
        } else if (replay.outcome === 'declined') {
          observed = { state: 'declined', amount: money(chargeTotal(intent), intent.currency) };
        } else if (replay.ref) {
          ref = replay.ref;
          observed = await adapter.getStatus(replay.ref);
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    return this.runner.system(tenantId, async (uow) => {
      const current = await this.ledger.lockIntent(uow.db, intentId);
      if (!current) return null;
      if (current.status !== 'uncertain') {
        await this.ledger.finishAttempt(uow.db, attempt.id, {
          status: 'succeeded',
          response: { skipped: 'already_resolved' },
        });
        return current.status;
      }
      const system: Caller = { source: 'system' };
      if (observed.state === 'unknown') {
        await this.ledger.finishAttempt(uow.db, attempt.id, {
          status: failure ? 'error' : 'succeeded',
          response: { state: 'unknown' },
          errorMessage: failure,
        });
        await this.ledger.annotate(
          uow,
          current,
          system,
          { kind: 'status_unknown', payload: { error: failure } },
          ref && !current.provider_reference ? { providerReference: ref.providerPaymentId } : {},
        );
        return 'uncertain';
      }
      await this.ledger.finishAttempt(uow.db, attempt.id, {
        status: 'succeeded',
        response: observed,
      });
      const payload = { source: 'getStatus', observed: observed.state };
      if (observed.state === 'captured' || observed.state === 'authorized') {
        const updated = await this.applyApproved(uow, current, system, {
          amount: observed.amount.amountMinor,
          ref,
          captureMode: observed.state === 'captured' ? 'auto' : 'manual',
          offline: false,
          account,
          terminal,
          eventKind: 'status_confirmed',
          payload,
        });
        return updated.status;
      }
      const updated = await this.applyDeclined(
        uow,
        current,
        system,
        `provider_${observed.state}`,
        `Provider reports ${observed.state}`,
        ref,
        'declined',
      );
      return updated.status;
    });
  }

  // --- capture / cancel / reverse ---------------------------------------------------------------

  capture(intentId: string, input: CaptureIntent): Promise<PaymentIntentDto> {
    return this.operate(intentId, 'capture', input);
  }

  cancel(intentId: string): Promise<PaymentIntentDto> {
    return this.operate(intentId, 'cancel', {});
  }

  reverse(intentId: string): Promise<PaymentIntentDto> {
    return this.operate(intentId, 'reverse', {});
  }

  private async operate(
    intentId: string,
    operation: Operation,
    input: CaptureIntent,
  ): Promise<PaymentIntentDto> {
    const { tenantId, actor, caller } = this.runner.request();
    const prepared = await this.runner.run(tenantId, actor, async (uow) => {
      const intent = await this.ledger.lockIntent(uow.db, intentId);
      if (!intent) throw new NotFoundError();
      await this.authz.assert(PAYMENT_PERMISSIONS.manage, {
        kind: 'location',
        id: intent.location_id,
      });
      if (operation === 'cancel' && intent.status === 'created') {
        const updated = await this.ledger.transition(uow, intent, 'cancelled', caller, {
          kind: 'cancelled',
          payload: {},
        });
        return { kind: 'done' as const, intent: updated };
      }
      const expected = operation === 'reverse' ? 'captured' : 'authorized';
      if (intent.status !== expected)
        throw new ConflictError(
          'INVALID_STATE',
          `Cannot ${operation} a payment that is ${intent.status}`,
        );
      if (!intent.provider_account_id || !intent.provider_reference)
        throw new ConflictError(
          'NO_PROVIDER_REFERENCE',
          'The payment has no provider reference to act on',
        );
      if (operation === 'reverse' && intent.offline && intent.forward_outcome !== 'approved')
        throw new ConflictError(
          'OFFLINE_NOT_FORWARDED',
          'An offline payment cannot be reversed until it has been forwarded',
        );
      const account = await uow.db.one<ProviderAccountRow>(
        'SELECT * FROM payments.payment_provider_accounts WHERE tenant_id = $1 AND id = $2',
        [uow.tenantId, intent.provider_account_id],
      );
      const adapter = this.registry.adapter(account.provider);
      let amount = chargeTotal(intent);
      let tip = intent.tip_minor;
      if (operation === 'capture') {
        tip = input.tipMinor !== undefined ? BigInt(input.tipMinor) : intent.tip_minor;
        const ceiling = intent.amount_minor + tip + intent.surcharge_minor;
        amount = input.amountMinor !== undefined ? BigInt(input.amountMinor) : ceiling;
        if (amount > ceiling)
          throw new ConflictError(
            'CAPTURE_EXCEEDS_AUTHORIZED',
            'Capture exceeds amount plus tip and surcharge',
          );
      }
      // Same key while the outcome is unknown (a retry replays the provider's answer); a new key only after
      // a certain decline, because providers replay a cached decline for the same key forever.
      const declined = await uow.db.one<{ n: bigint }>(
        `SELECT COUNT(*)::bigint AS n FROM payments.payment_attempts
          WHERE tenant_id = $1 AND intent_id = $2 AND operation = $3 AND status = 'declined'`,
        [uow.tenantId, intent.id, operation],
      );
      const idem = idempotencyKey(
        declined.n === 0n ? `${intent.id}:${operation}` : `${intent.id}:${operation}:${declined.n}`,
      );
      const attempt = await this.ledger.startAttempt(uow.db, intent.id, {
        operation,
        providerIdempotencyKey: idem,
        request: {
          amountMinor: amount.toString(),
          currency: intent.currency.trim(),
          providerReference: intent.provider_reference,
        },
      });
      return { kind: 'go' as const, intent, adapter, amount, tip, idem, attempt };
    });
    if (prepared.kind === 'done') return toIntentDto(prepared.intent, null);

    const { intent, adapter, amount, tip, idem, attempt } = prepared;
    const ref: ProviderRef = {
      provider: adapter.key,
      providerPaymentId: intent.provider_reference!,
    };
    let result: ProviderResult | null = null;
    let failure: string | null = null;
    try {
      result =
        operation === 'capture'
          ? await adapter.capture(ref, money(amount, intent.currency), idem)
          : await adapter.reverse(ref, idem);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    await this.faults.afterProviderCall?.(intent);

    const settled = await this.runner.run(
      tenantId,
      actor,
      async (uow): Promise<{ dto: PaymentIntentDto } | { error: ConflictError }> => {
        const current = await this.ledger.lockIntent(uow.db, intent.id);
        if (!current) throw new NotFoundError();
        const expected = operation === 'reverse' ? 'captured' : 'authorized';
        if (current.status !== expected) {
          await this.ledger.finishAttempt(uow.db, attempt.id, {
            status: 'succeeded',
            response: { skipped: 'state_changed' },
          });
          return { dto: toIntentDto(current, await this.ledger.getCard(uow.db, current.id)) };
        }
        if (result?.outcome === 'approved') {
          await this.ledger.finishAttempt(uow.db, attempt.id, {
            status: 'succeeded',
            response: result,
          });
          const updated = await this.applyOperation(uow, current, operation, caller, amount, tip);
          return { dto: toIntentDto(updated, await this.ledger.getCard(uow.db, updated.id)) };
        }
        // Failure paths commit their attempt and event records; the error is thrown after the commit.
        if (result?.outcome === 'declined') {
          await this.ledger.finishAttempt(uow.db, attempt.id, {
            status: 'declined',
            response: result,
            errorCode: result.code,
            errorMessage: result.message,
          });
          await this.ledger.insertEvent(uow.db, current.id, caller, {
            kind: `${operation}_declined`,
            from: current.status,
            to: current.status,
            payload: { code: result.code },
          });
          return {
            error: new ConflictError(`${operation.toUpperCase()}_DECLINED`, result.message),
          };
        }
        await this.ledger.finishAttempt(uow.db, attempt.id, {
          status: 'timeout',
          errorCode: 'uncertain',
          errorMessage: failure ?? 'uncertain',
        });
        await this.ledger.insertEvent(uow.db, current.id, caller, {
          kind: 'timeout',
          from: current.status,
          to: current.status,
          payload: { operation, reason: failure ?? 'uncertain' },
        });
        return {
          error: new ConflictError(
            'PROVIDER_UNCERTAIN',
            `The provider did not confirm the ${operation}; retry to replay it safely`,
          ),
        };
      },
    );
    if ('error' in settled) throw settled.error;
    return settled.dto;
  }

  private async applyOperation(
    uow: TenantUnitOfWork,
    intent: IntentRow,
    operation: Operation,
    caller: Caller,
    amount: bigint,
    tip: bigint,
  ): Promise<IntentRow> {
    if (operation === 'capture') {
      const updated = await this.ledger.transition(
        uow,
        intent,
        'captured',
        caller,
        { kind: 'captured', amountMinor: amount, payload: { tipMinor: tip.toString() } },
        { capturedMinor: amount, tipMinor: tip },
      );
      await this.ledger.syncOrder(uow, updated);
      this.ledger.emit(uow, 'payment.captured', updated);
      return updated;
    }
    if (operation === 'cancel') {
      return this.ledger.transition(
        uow,
        intent,
        'cancelled',
        caller,
        { kind: 'cancelled', payload: { released: true } },
        { authorizedMinor: 0n },
      );
    }
    const updated = await this.ledger.transition(
      uow,
      intent,
      'reversed',
      caller,
      { kind: 'reversed', amountMinor: intent.captured_minor, payload: {} },
      { capturedMinor: 0n },
    );
    await this.ledger.syncOrder(uow, updated);
    return updated;
  }

  // --- recovery of a crashed capture/cancel/reverse -------------------------------------------------

  /** An open capture/cancel/reverse attempt whose result was never recorded: ask the provider what state the payment is in. */
  async recoverOperation(tenantId: string, intentId: string): Promise<boolean> {
    const found = await this.runner.system(tenantId, async (uow) => {
      const intent = await this.ledger.getIntent(uow.db, intentId);
      const attempt = intent ? await this.ledger.openAttempt(uow.db, intentId) : null;
      if (!intent || !attempt || !intent.provider_reference || !intent.provider_account_id)
        return null;
      if (!['capture', 'cancel', 'reverse'].includes(attempt.operation)) return null;
      const account = await uow.db.one<ProviderAccountRow>(
        'SELECT * FROM payments.payment_provider_accounts WHERE tenant_id = $1 AND id = $2',
        [uow.tenantId, intent.provider_account_id],
      );
      return { intent, attempt, account };
    });
    if (!found) return false;
    const adapter = this.registry.find(found.account.provider);
    if (!adapter) return false;
    let observed: ProviderStatus;
    try {
      observed = await adapter.getStatus({
        provider: adapter.key,
        providerPaymentId: found.intent.provider_reference!,
      });
    } catch {
      return false;
    }
    return this.runner.system(tenantId, async (uow) => {
      const current = await this.ledger.lockIntent(uow.db, intentId);
      if (!current) return false;
      const op = found.attempt.operation as Operation;
      const system: Caller = { source: 'system' };
      let applied = false;
      if (op === 'capture' && current.status === 'authorized' && observed.state === 'captured') {
        await this.applyOperation(
          uow,
          current,
          'capture',
          system,
          observed.amount.amountMinor,
          current.tip_minor,
        );
        applied = true;
      } else if (
        op === 'cancel' &&
        current.status === 'authorized' &&
        observed.state === 'reversed'
      ) {
        await this.applyOperation(uow, current, 'cancel', system, 0n, 0n);
        applied = true;
      } else if (
        op === 'reverse' &&
        current.status === 'captured' &&
        observed.state === 'reversed'
      ) {
        await this.applyOperation(uow, current, 'reverse', system, 0n, 0n);
        applied = true;
      }
      await this.ledger.finishAttempt(uow.db, found.attempt.id, {
        status: applied ? 'succeeded' : 'timeout',
        response: { recovered: applied, observed: observed.state },
        ...(applied ? {} : { errorCode: 'not_applied' }),
      });
      return applied;
    });
  }
}
