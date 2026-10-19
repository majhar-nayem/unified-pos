import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  PAYMENT_PERMISSIONS,
  type Page,
  type WebhookInboxEntryDto,
  type WebhookReceiptDto,
} from '@pos/contracts';
import { newId, type TenantUnitOfWork } from '@pos/db';
import { createLogger } from '@pos/observability';
import { type WebhookEvent, type WebhookHeaders, redactForStorage } from '@pos/payments-sdk';

import {
  AuthorizationService,
  NotFoundError,
  UnauthorizedError,
  UnitOfWork,
} from '../kernel/public/index.js';
import {
  chargeTotal,
  type IntentRow,
  type ProviderAccountRow,
  type WebhookInboxRow,
  toWebhookInboxDto,
} from './rows.js';
import { type Caller, PaymentsLedger } from './ledger.service.js';
import { PaymentsRunner } from './payments-runner.js';
import { PAYMENT_SECRETS, type PaymentSecretsPort } from './ports/secrets.port.js';
import { PROVIDER_REGISTRY, ProviderRegistry } from './providers/provider-registry.js';

const WEBHOOK_CALLER: Caller = { source: 'provider_webhook' };
const MAX_ATTEMPTS = 5;

/** The normalised event stored in the inbox so a failed processing can be retried without re-verifying. */
interface StoredEvent {
  type: WebhookEvent['type'];
  rawType: string;
  occurredAt: string;
  refPaymentId: string | null;
  amountMinor: string | null;
  currency: string | null;
  refundedMinor: string | null;
  metadata: Record<string, string>;
}

export type WebhookOutcome = 'processed' | 'ignored';

/**
 * Webhook inbox (docs/01 §7.3, plan §5 F5). The route carries tenant and provider account in its
 * path; that only selects the row-level-security context and the signing secret. Authenticity
 * comes from the signature over the RAW body with that account's secret. Every delivery is
 * recorded: an invalid signature is stored (metadata only, never the unverified body), logged and
 * refused; a valid one is deduplicated on (provider, event id) so a replay is a no-op; processing
 * is idempotent and runs in a savepoint so a failure leaves a retryable `failed` row.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = createLogger({ service: 'payments.webhooks' });

  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly runner: PaymentsRunner,
    private readonly ledger: PaymentsLedger,
    @Inject(PROVIDER_REGISTRY) private readonly registry: ProviderRegistry,
    @Inject(PAYMENT_SECRETS) private readonly secrets: PaymentSecretsPort,
  ) {}

  async receive(input: {
    provider: string;
    tenantId: string;
    accountId: string;
    headers: WebhookHeaders;
    rawBody: Buffer;
    ip?: string | undefined;
  }): Promise<WebhookReceiptDto> {
    const account = await this.runner.system(input.tenantId, (uow) =>
      uow.db.maybeOne<ProviderAccountRow>(
        'SELECT * FROM payments.payment_provider_accounts WHERE tenant_id = $1 AND id = $2 AND provider = $3',
        [uow.tenantId, input.accountId, input.provider],
      ),
    );
    if (!account) {
      this.logger.warn(
        { provider: input.provider, accountId: input.accountId },
        'webhook for unknown provider account',
      );
      throw new NotFoundError();
    }
    const adapter = this.registry.find(account.provider);
    const secret = await this.secrets.webhookSecret({
      provider: account.provider,
      credentialsRef: account.credentials_ref,
    });
    const verified =
      adapter && secret
        ? adapter.verifyWebhook(input.headers, input.rawBody, secret)
        : ({
            kind: 'invalid_signature',
            provider: account.provider,
            reason: secret ? 'bad_payload' : 'missing_header',
          } as const);

    if (verified.kind === 'invalid_signature') {
      // Committed in its own transaction BEFORE the refusal below, or the rollback would lose the evidence.
      const inboxId = await this.runner.system(input.tenantId, async (uow) => {
        const id = newId();
        await uow.db.query(
          `INSERT INTO payments.webhook_inbox
             (id, tenant_id, provider, provider_account_id, external_event_id, signature_valid, status, error, payload)
           VALUES ($1, $2, $3, $4, $5, false, 'invalid_signature', $6, $7)`,
          [
            id,
            uow.tenantId,
            account.provider,
            account.id,
            `invalid:${id}`, // never the claimed event id: a forger must not be able to burn a real one
            verified.reason,
            JSON.stringify({
              reason: verified.reason,
              bodySha256: createHash('sha256').update(input.rawBody).digest('hex'),
              bodyBytes: input.rawBody.length,
              ip: input.ip ?? null,
            }),
          ],
        );
        uow.audit({
          action: 'payments.webhook.rejected',
          resourceKind: 'webhook_inbox',
          resourceId: id,
          after: { provider: account.provider, accountId: account.id, reason: verified.reason },
        });
        return id;
      });
      this.logger.warn(
        {
          provider: account.provider,
          tenantId: input.tenantId,
          accountId: account.id,
          reason: verified.reason,
          inboxId,
          ip: input.ip,
        },
        'webhook rejected: invalid signature',
      );
      throw new UnauthorizedError('INVALID_SIGNATURE', 'Webhook signature verification failed');
    }

    const stored = this.toStored(verified);
    return this.runner.system(input.tenantId, async (uow) => {
      const id = newId();
      const inserted = await uow.db.query<{ id: string }>(
        `INSERT INTO payments.webhook_inbox
           (id, tenant_id, provider, provider_account_id, external_event_id, event_type, signature_valid, status, attempts, payload)
         VALUES ($1, $2, $3, $4, $5, $6, true, 'received', 1, $7)
         ON CONFLICT (provider, external_event_id) DO NOTHING
         RETURNING id`,
        [
          id,
          uow.tenantId,
          account.provider,
          account.id,
          verified.externalEventId,
          verified.rawType,
          JSON.stringify({ normalized: stored, raw: redactForStorage(verified.payload) }),
        ],
      );
      if (!inserted[0]) return { status: 'duplicate' as const, inboxId: null };
      const outcome = await this.processGuarded(uow, id, stored, account);
      return { status: outcome, inboxId: id };
    });
  }

  /** Run `process` in a savepoint; on failure mark the inbox row `failed` (retried by the sweeper) instead of losing the delivery. */
  private async processGuarded(
    uow: TenantUnitOfWork,
    inboxId: string,
    event: StoredEvent,
    account: ProviderAccountRow,
  ): Promise<'processed' | 'ignored' | 'failed'> {
    await uow.db.query('SAVEPOINT webhook_process');
    try {
      const outcome = await this.process(uow, event, account);
      await uow.db.query('RELEASE SAVEPOINT webhook_process');
      await uow.db.query(
        `UPDATE payments.webhook_inbox SET status = $3, processed_at = now(), error = NULL
          WHERE tenant_id = $1 AND id = $2`,
        [uow.tenantId, inboxId, outcome],
      );
      return outcome;
    } catch (error) {
      await uow.db.query('ROLLBACK TO SAVEPOINT webhook_process');
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ inboxId, err: message }, 'webhook processing failed; will retry');
      await uow.db.query(
        `UPDATE payments.webhook_inbox SET status = 'failed', error = $3 WHERE tenant_id = $1 AND id = $2`,
        [uow.tenantId, inboxId, message.slice(0, 1000)],
      );
      return 'failed';
    }
  }

  private async process(
    uow: TenantUnitOfWork,
    event: StoredEvent,
    account: ProviderAccountRow,
  ): Promise<WebhookOutcome> {
    const intent = await this.findIntent(uow, event, account);
    if (!intent) return 'ignored';
    const ref = event.refPaymentId;
    let current = intent;
    current = await this.ledger.annotate(uow, current, WEBHOOK_CALLER, {
      kind: 'webhook_received',
      payload: { type: event.type, rawType: event.rawType },
    });
    const amount = event.amountMinor === null ? null : BigInt(event.amountMinor);
    const patchRef = !current.provider_reference && ref ? { providerReference: ref } : {};

    switch (event.type) {
      case 'payment.captured': {
        if (['captured', 'partially_refunded', 'refunded'].includes(current.status))
          return 'processed';
        if (!['processing', 'uncertain', 'authorized'].includes(current.status))
          return this.contradiction(uow, current, event);
        const captured =
          amount === null
            ? chargeTotal(current)
            : amount > chargeTotal(current)
              ? chargeTotal(current)
              : amount;
        const updated = await this.ledger.transition(
          uow,
          current,
          'captured',
          WEBHOOK_CALLER,
          { kind: 'captured', amountMinor: captured, payload: { source: 'webhook' } },
          { capturedMinor: captured, authorizedMinor: captured, ...patchRef },
        );
        await this.ledger.syncOrder(uow, updated);
        this.ledger.emit(uow, 'payment.captured', updated);
        return 'processed';
      }
      case 'payment.authorized': {
        if (['authorized', 'captured', 'partially_refunded', 'refunded'].includes(current.status))
          return 'processed';
        if (!['processing', 'uncertain'].includes(current.status))
          return this.contradiction(uow, current, event);
        const authorized =
          amount === null
            ? chargeTotal(current)
            : amount > chargeTotal(current)
              ? chargeTotal(current)
              : amount;
        const updated = await this.ledger.transition(
          uow,
          current,
          'authorized',
          WEBHOOK_CALLER,
          { kind: 'authorized', amountMinor: authorized, payload: { source: 'webhook' } },
          { authorizedMinor: authorized, ...patchRef },
        );
        this.ledger.emit(uow, 'payment.authorized', updated);
        return 'processed';
      }
      case 'payment.declined': {
        if (['failed', 'cancelled'].includes(current.status)) return 'processed';
        if (!['processing', 'uncertain'].includes(current.status))
          return this.contradiction(uow, current, event);
        const updated = await this.ledger.transition(
          uow,
          current,
          'failed',
          WEBHOOK_CALLER,
          { kind: 'declined', payload: { source: 'webhook' } },
          { lastError: { code: 'provider_declined', source: 'webhook' }, ...patchRef },
        );
        this.ledger.emit(uow, 'payment.failed', updated, { code: 'provider_declined' });
        return 'processed';
      }
      case 'payment.reversed': {
        if (['reversed', 'cancelled'].includes(current.status)) return 'processed';
        if (current.status === 'authorized') {
          await this.ledger.transition(
            uow,
            current,
            'cancelled',
            WEBHOOK_CALLER,
            { kind: 'cancelled', payload: { source: 'webhook' } },
            { authorizedMinor: 0n },
          );
          return 'processed';
        }
        if (current.status === 'captured') {
          const updated = await this.ledger.transition(
            uow,
            current,
            'reversed',
            WEBHOOK_CALLER,
            { kind: 'reversed', payload: { source: 'webhook' } },
            { capturedMinor: 0n },
          );
          await this.ledger.syncOrder(uow, updated);
          return 'processed';
        }
        return this.contradiction(uow, current, event);
      }
      case 'refund.succeeded': {
        const providerRefunded = event.refundedMinor === null ? null : BigInt(event.refundedMinor);
        if (providerRefunded !== null && providerRefunded > current.refunded_minor) {
          // A refund we did not record (issued from the provider dashboard) or one still in flight on our side.
          const pending = await uow.db.one<{ n: bigint }>(
            `SELECT COUNT(*)::bigint AS n FROM payments.refunds
              WHERE tenant_id = $1 AND intent_id = $2 AND status IN ('processing','uncertain')`,
            [uow.tenantId, current.id],
          );
          if (pending.n === 0n)
            await this.ledger.raiseException(uow.db, {
              kind: 'amount_mismatch',
              severity: 'high',
              subjectKind: 'payment_intent',
              subjectId: current.id,
              details: {
                source: 'webhook_refund',
                providerRefundedMinor: providerRefunded.toString(),
                platformRefundedMinor: current.refunded_minor.toString(),
              },
            });
        }
        return 'processed';
      }
      case 'dispute.opened': {
        const disputed = amount ?? current.captured_minor;
        await uow.db.query(
          `INSERT INTO payments.disputes (id, tenant_id, intent_id, provider_reference, amount_minor, currency, reason_code, status, opened_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'opened', $8)`,
          [
            newId(),
            uow.tenantId,
            current.id,
            ref ?? current.provider_reference ?? 'unknown',
            disputed,
            current.currency.trim(),
            event.metadata.reason ?? null,
            new Date(event.occurredAt),
          ],
        );
        await this.ledger.annotate(
          uow,
          current,
          WEBHOOK_CALLER,
          { kind: 'dispute_opened', amountMinor: disputed, payload: {} },
          { settlementStatus: 'disputed' },
        );
        return 'processed';
      }
      default:
        return 'ignored';
    }
  }

  /** The provider says something our state machine says cannot be: never "fix" it silently, raise it. */
  private async contradiction(
    uow: TenantUnitOfWork,
    intent: IntentRow,
    event: StoredEvent,
  ): Promise<WebhookOutcome> {
    await this.ledger.raiseException(uow.db, {
      kind: 'amount_mismatch',
      severity: 'critical',
      subjectKind: 'payment_intent',
      subjectId: intent.id,
      details: {
        source: 'webhook_contradiction',
        platformStatus: intent.status,
        providerEvent: event.type,
        amountMinor: event.amountMinor,
      },
    });
    return 'processed';
  }

  private async findIntent(
    uow: TenantUnitOfWork,
    event: StoredEvent,
    account: ProviderAccountRow,
  ): Promise<IntentRow | null> {
    const intentId = event.metadata.intentId;
    if (
      intentId &&
      /^[0-9a-f-]{36}$/i.test(intentId) &&
      (!event.metadata.tenantId || event.metadata.tenantId === uow.tenantId)
    ) {
      const byId = await uow.db.maybeOne<IntentRow>(
        'SELECT * FROM payments.payment_intents WHERE tenant_id = $1 AND id = $2 AND provider_account_id = $3 FOR UPDATE',
        [uow.tenantId, intentId, account.id],
      );
      if (byId) return byId;
    }
    if (!event.refPaymentId) return null;
    return uow.db.maybeOne<IntentRow>(
      `SELECT * FROM payments.payment_intents
        WHERE tenant_id = $1 AND provider_account_id = $2 AND provider_reference = $3 FOR UPDATE`,
      [uow.tenantId, account.id, event.refPaymentId],
    );
  }

  private toStored(event: WebhookEvent): StoredEvent {
    return {
      type: event.type,
      rawType: event.rawType,
      occurredAt: event.occurredAt.toISOString(),
      refPaymentId: event.ref?.providerPaymentId ?? null,
      amountMinor: event.amount ? event.amount.amountMinor.toString() : null,
      currency: event.amount?.currency ?? null,
      refundedMinor: event.refundedMinor === undefined ? null : event.refundedMinor.toString(),
      metadata: { ...event.metadata },
    };
  }

  /** Re-run `received`/`failed` deliveries (the sweeper's inbox retry). Returns how many reached a final state. */
  async retryPending(tenantId: string, limit = 50): Promise<number> {
    const rows = await this.runner.system(tenantId, (uow) =>
      uow.db.query<WebhookInboxRow & { payload: { normalized: StoredEvent } }>(
        `SELECT * FROM payments.webhook_inbox
          WHERE tenant_id = $1 AND status IN ('received','failed') AND signature_valid AND attempts < $2
          ORDER BY received_at LIMIT ${limit}`,
        [tenantId, MAX_ATTEMPTS],
      ),
    );
    let done = 0;
    for (const row of rows) {
      const outcome = await this.runner.system(tenantId, async (uow) => {
        const account = row.provider_account_id
          ? await uow.db.maybeOne<ProviderAccountRow>(
              'SELECT * FROM payments.payment_provider_accounts WHERE tenant_id = $1 AND id = $2',
              [uow.tenantId, row.provider_account_id],
            )
          : null;
        if (!account) return 'ignored' as const;
        await uow.db.query(
          'UPDATE payments.webhook_inbox SET attempts = attempts + 1 WHERE tenant_id = $1 AND id = $2',
          [uow.tenantId, row.id],
        );
        return this.processGuarded(uow, row.id, row.payload.normalized, account);
      });
      if (outcome !== 'failed') done += 1;
    }
    return done;
  }

  async list(query: {
    status?: WebhookInboxEntryDto['status'];
    cursor?: string | undefined;
    limit: number;
  }): Promise<Page<WebhookInboxEntryDto>> {
    this.authz.assertAnywhere(PAYMENT_PERMISSIONS.providerManage);
    const rows = await this.uow.read((db) => {
      const params: unknown[] = [db.tenantId];
      const where = ['tenant_id = $1'];
      if (query.status) {
        params.push(query.status);
        where.push(`status = $${params.length}`);
      }
      if (query.cursor) {
        params.push(query.cursor);
        where.push(`id > $${params.length}`);
      }
      return db.query<WebhookInboxRow>(
        `SELECT id, tenant_id, provider, provider_account_id, external_event_id, event_type, signature_valid,
                received_at, processed_at, status, attempts, error
           FROM payments.webhook_inbox WHERE ${where.join(' AND ')} ORDER BY id LIMIT ${query.limit + 1}`,
        params,
      );
    });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map(toWebhookInboxDto),
      nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }
}
