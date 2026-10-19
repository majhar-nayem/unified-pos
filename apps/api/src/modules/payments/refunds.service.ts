import { Inject, Injectable } from '@nestjs/common';
import { type CreateRefund, PAYMENT_PERMISSIONS, type RefundDto } from '@pos/contracts';
import { newId, type TenantScopedDb, type TenantUnitOfWork } from '@pos/db';
import { type IdempotencyKey, type ProviderResult, idempotencyKey } from '@pos/payments-sdk';

import {
  AuthorizationService,
  ConflictError,
  NotFoundError,
  RequestContextService,
  UnitOfWork,
  ValidationError,
  isOperator,
} from '../kernel/public/index.js';
import { statusAfterRefund } from './domain/state-machine.js';
import { type Caller, PaymentsLedger } from './ledger.service.js';
import { PaymentsRunner } from './payments-runner.js';
import { PROVIDER_REGISTRY, ProviderRegistry } from './providers/provider-registry.js';
import { type IntentRow, type ProviderAccountRow, type RefundRow, toRefundDto } from './rows.js';
import type { PaymentIntentStatus } from '@pos/contracts';

export interface RefundFaults {
  afterProviderCall?: (refund: RefundRow) => void | Promise<void>;
}
export const REFUND_FAULTS = Symbol('REFUND_FAULTS');

/** Refund statuses that already count against what can still be refunded. */
const COUNTING = ['pending', 'processing', 'uncertain', 'succeeded'];

@Injectable()
export class RefundsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly context: RequestContextService,
    private readonly runner: PaymentsRunner,
    private readonly ledger: PaymentsLedger,
    @Inject(PROVIDER_REGISTRY) private readonly registry: ProviderRegistry,
    @Inject(REFUND_FAULTS) private readonly faults: RefundFaults,
  ) {}

  /**
   * Refund part or all of a captured payment. `orders.refund.create` is checked against the intent's
   * location with the amount as the `orders.refund.max_minor` attribute, so a limit breach surfaces
   * as LIMIT_EXCEEDED for the approvals flow. The provider is called outside any transaction with a
   * stable per-refund idempotency key, so a crash or retry can never refund twice.
   */
  async create(intentId: string, input: CreateRefund): Promise<RefundDto> {
    const { tenantId, actor, caller } = this.runner.request();
    const amount = BigInt(input.amountMinor);
    const prepared = await this.runner.run(tenantId, actor, async (uow) => {
      const intent = await this.ledger.lockIntent(uow.db, intentId);
      if (!intent) throw new NotFoundError();
      await this.authz.assert(
        'orders.refund.create',
        { kind: 'location', id: intent.location_id },
        { 'orders.refund.max_minor': Number(amount) },
      );
      const key = this.idempotencyKey(input.clientRefundId);
      const existing = await uow.db.maybeOne<RefundRow>(
        'SELECT * FROM payments.refunds WHERE tenant_id = $1 AND idempotency_key = $2',
        [uow.tenantId, key],
      );
      if (existing) {
        if (existing.intent_id !== intent.id || existing.amount_minor !== amount)
          throw new ValidationError(
            { clientRefundId: 'reused with a different payment or amount' },
            'clientRefundId was already used for a different refund',
          );
        return { kind: 'replay' as const, refund: existing };
      }
      if (intent.status !== 'captured' && intent.status !== 'partially_refunded')
        throw new ConflictError(
          'INVALID_STATE',
          `Cannot refund a payment that is ${intent.status}`,
        );
      if (intent.offline && intent.forward_outcome !== 'approved')
        throw new ConflictError(
          'OFFLINE_NOT_FORWARDED',
          'An offline payment cannot be refunded until it has been forwarded',
        );
      const method = intent.method === 'cash' ? 'cash' : input.method;
      if (method === 'store_credit' || method === 'gift_card')
        throw new ConflictError('METHOD_NOT_SUPPORTED', `Refund to ${method} is not available yet`);
      if (method === 'original' && !intent.provider_reference && intent.method !== 'cash')
        throw new ConflictError(
          'NO_PROVIDER_REFERENCE',
          'The payment has no provider reference to refund against',
        );

      const counted = await uow.db.one<{ total: bigint }>(
        `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS total FROM payments.refunds
          WHERE tenant_id = $1 AND intent_id = $2 AND status = ANY($3::text[])`,
        [uow.tenantId, intent.id, COUNTING],
      );
      if (counted.total + amount > intent.captured_minor)
        throw new ConflictError(
          'REFUND_EXCEEDS_CAPTURED',
          'Refunds would exceed the amount captured on this payment',
        );

      const refundId = newId();
      const inserted = await uow.db.query<RefundRow>(
        `INSERT INTO payments.refunds
           (id, tenant_id, intent_id, order_id, idempotency_key, amount_minor, reason, method, status, approval_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'processing', $9, $10) RETURNING *`,
        [
          refundId,
          uow.tenantId,
          intent.id,
          input.orderId,
          key,
          amount,
          input.reason ?? null,
          method,
          input.approvalId ?? null,
          caller.actorUserId ?? null,
        ],
      );
      const refund = inserted[0]!;
      await this.ledger.insertEvent(uow.db, intent.id, caller, {
        kind: 'refund_requested',
        amountMinor: amount,
        payload: { refundId, method, returnOrderId: input.orderId },
      });
      let account: ProviderAccountRow | null = null;
      let attemptId: string | null = null;
      const idem = idempotencyKey(`${refundId}:refund`);
      if (method === 'original') {
        account = await uow.db.one<ProviderAccountRow>(
          'SELECT * FROM payments.payment_provider_accounts WHERE tenant_id = $1 AND id = $2',
          [uow.tenantId, intent.provider_account_id],
        );
        this.registry.adapter(account.provider);
        const attempt = await this.ledger.startAttempt(uow.db, intent.id, {
          operation: 'refund',
          providerIdempotencyKey: idem,
          request: { amountMinor: amount.toString(), currency: intent.currency.trim(), refundId },
        });
        attemptId = attempt.id;
      }
      return { kind: 'go' as const, refund, intent, account, attemptId, idem };
    });
    if (prepared.kind === 'replay') return toRefundDto(prepared.refund);

    const { refund, intent, account, attemptId, idem } = prepared;
    let result: ProviderResult | null = null;
    let failure: string | null = null;
    if (account) {
      result = await this.callRefund(account, intent, refund.amount_minor, idem).catch(
        (error: unknown) => {
          failure = error instanceof Error ? error.message : String(error);
          return null;
        },
      );
    }
    await this.faults.afterProviderCall?.(refund);

    return this.runner.run(tenantId, actor, (uow) =>
      this.settle(
        uow,
        refund.id,
        account
          ? result
          : {
              outcome: 'approved',
              ref: { provider: 'mock', providerPaymentId: `cash_${refund.id}` },
              amount: { amountMinor: refund.amount_minor, currency: intent.currency.trim() },
            },
        failure,
        attemptId,
        caller,
        !account,
      ),
    );
  }

  private callRefund(
    account: ProviderAccountRow,
    intent: IntentRow,
    amount: bigint,
    idem: IdempotencyKey,
  ): Promise<ProviderResult> {
    const adapter = this.registry.adapter(account.provider);
    return adapter.refund(
      { provider: adapter.key, providerPaymentId: intent.provider_reference! },
      { amountMinor: amount, currency: intent.currency.trim() },
      idem,
    );
  }

  private async settle(
    uow: TenantUnitOfWork,
    refundId: string,
    result: ProviderResult | null,
    failure: string | null,
    attemptId: string | null,
    caller: Caller,
    cash: boolean,
  ): Promise<RefundDto> {
    const refund = await uow.db.maybeOne<RefundRow>(
      'SELECT * FROM payments.refunds WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
      [uow.tenantId, refundId],
    );
    if (!refund) throw new NotFoundError();
    if (refund.status !== 'processing' && refund.status !== 'uncertain') return toRefundDto(refund);
    const intent = (await this.ledger.lockIntent(uow.db, refund.intent_id))!;

    if (result?.outcome === 'approved') {
      if (attemptId)
        await this.ledger.finishAttempt(uow.db, attemptId, {
          status: 'succeeded',
          response: result,
        });
      return toRefundDto(
        await this.applySucceeded(uow, refund, intent, caller, result.ref.providerPaymentId, cash),
      );
    }
    if (result?.outcome === 'declined') {
      if (attemptId)
        await this.ledger.finishAttempt(uow.db, attemptId, {
          status: 'declined',
          response: result,
          errorCode: result.code,
          errorMessage: result.message,
        });
      const updated = await this.finish(uow, refund.id, 'failed');
      await this.ledger.insertEvent(uow.db, intent.id, caller, {
        kind: 'refund_declined',
        from: intent.status,
        to: intent.status,
        amountMinor: refund.amount_minor,
        payload: { refundId, code: result.code },
      });
      return toRefundDto(updated);
    }
    if (attemptId)
      await this.ledger.finishAttempt(uow.db, attemptId, {
        status: 'timeout',
        errorCode: 'uncertain',
        errorMessage: failure ?? (result?.outcome === 'uncertain' ? result.reason : 'uncertain'),
      });
    const updated = await this.finish(uow, refund.id, 'uncertain', false);
    await this.ledger.insertEvent(uow.db, intent.id, caller, {
      kind: 'timeout',
      from: intent.status,
      to: intent.status,
      amountMinor: refund.amount_minor,
      payload: { refundId, operation: 'refund' },
    });
    return toRefundDto(updated);
  }

  private async finish(
    uow: TenantUnitOfWork,
    refundId: string,
    status: RefundRow['status'],
    terminal = true,
    providerReference?: string,
  ): Promise<RefundRow> {
    return uow.db.one<RefundRow>(
      `UPDATE payments.refunds
          SET status = $3, finished_at = CASE WHEN $4 THEN now() ELSE finished_at END,
              provider_reference = COALESCE($5, provider_reference)
        WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [uow.tenantId, refundId, status, terminal, providerReference ?? null],
    );
  }

  private async applySucceeded(
    uow: TenantUnitOfWork,
    refund: RefundRow,
    intent: IntentRow,
    caller: Caller,
    providerReference: string,
    cash: boolean,
  ): Promise<RefundRow> {
    const refunded = intent.refunded_minor + refund.amount_minor;
    const target: PaymentIntentStatus = statusAfterRefund(
      intent.status,
      intent.captured_minor,
      refunded,
    );
    const event = {
      kind: 'refunded',
      amountMinor: refund.amount_minor,
      payload: { refundId: refund.id, returnOrderId: refund.order_id, cash },
    };
    const updated =
      target === intent.status
        ? await this.ledger.annotate(uow, intent, caller, event, { refundedMinor: refunded })
        : await this.ledger.transition(uow, intent, target, caller, event, {
            refundedMinor: refunded,
          });
    await this.ledger.syncOrder(uow, updated);
    this.ledger.emit(uow, 'refund.succeeded', updated, {
      refundId: refund.id,
      refundAmountMinor: refund.amount_minor.toString(),
      returnOrderId: refund.order_id,
    });
    uow.audit({
      action: 'payments.refund.succeeded',
      resourceKind: 'refund',
      resourceId: refund.id,
      locationId: intent.location_id,
      approvalId: refund.approval_id,
      after: {
        intentId: intent.id,
        amountMinor: refund.amount_minor.toString(),
        method: refund.method,
      },
    });
    return this.finish(uow, refund.id, 'succeeded', true, providerReference);
  }

  /**
   * Resolve a refund that ended `uncertain` (or was stuck `processing` after a crash) by replaying
   * the provider call under the same per-refund key: the provider returns the original outcome.
   */
  async resolveRefund(tenantId: string, refundId: string): Promise<RefundRow['status'] | null> {
    const prep = await this.runner.system(tenantId, async (uow) => {
      const refund = await this.ledger.getRefund(uow.db, refundId);
      if (!refund || (refund.status !== 'uncertain' && refund.status !== 'processing')) return null;
      const intent = await this.ledger.getIntent(uow.db, refund.intent_id);
      if (!intent) return null;
      if (refund.method !== 'original') return { refund, intent, account: null, attemptId: null };
      const account = await uow.db.one<ProviderAccountRow>(
        'SELECT * FROM payments.payment_provider_accounts WHERE tenant_id = $1 AND id = $2',
        [uow.tenantId, intent.provider_account_id],
      );
      if (!this.registry.find(account.provider)) return null;
      const attempt = await this.ledger.startAttempt(uow.db, intent.id, {
        operation: 'status_query',
        providerIdempotencyKey: `${refund.id}:refund`,
        request: { via: 'idempotent_replay', refundId: refund.id },
      });
      return { refund, intent, account, attemptId: attempt.id };
    });
    if (!prep) return null;
    let result: ProviderResult | null = null;
    let failure: string | null = null;
    if (prep.account) {
      result = await this.callRefund(
        prep.account,
        prep.intent,
        prep.refund.amount_minor,
        idempotencyKey(`${prep.refund.id}:refund`),
      ).catch((error: unknown) => {
        failure = error instanceof Error ? error.message : String(error);
        return null;
      });
      if (result?.outcome === 'uncertain' || result === null) {
        // still unknown: leave it uncertain (the sweeper will try again), but record the query
        return this.runner.system(tenantId, async (uow) => {
          if (prep.attemptId)
            await this.ledger.finishAttempt(uow.db, prep.attemptId, {
              status: failure ? 'error' : 'succeeded',
              response: { state: 'unknown' },
              errorMessage: failure,
            });
          const current = await this.ledger.getRefund(uow.db, refundId);
          if (current?.status === 'processing')
            await this.finish(uow, refundId, 'uncertain', false);
          return 'uncertain' as const;
        });
      }
    }
    const status = await this.runner.system(tenantId, async (uow) => {
      const out = await this.settle(
        uow,
        refundId,
        prep.account
          ? result
          : {
              outcome: 'approved',
              ref: { provider: 'mock', providerPaymentId: `cash_${refundId}` },
              amount: {
                amountMinor: prep.refund.amount_minor,
                currency: prep.intent.currency.trim(),
              },
            },
        failure,
        prep.attemptId,
        { source: 'system' },
        !prep.account,
      );
      return out.status;
    });
    return status;
  }

  async list(intentId: string): Promise<RefundDto[]> {
    const intent = await this.uow.read((db) => this.ledger.getIntent(db, intentId));
    if (!intent) throw new NotFoundError();
    await this.authz.assert(PAYMENT_PERMISSIONS.view, { kind: 'location', id: intent.location_id });
    const rows = await this.uow.read((db) =>
      db.query<RefundRow>(
        'SELECT * FROM payments.refunds WHERE tenant_id = $1 AND intent_id = $2 ORDER BY id',
        [db.tenantId, intentId],
      ),
    );
    return rows.map(toRefundDto);
  }

  async stuck(db: TenantScopedDb, olderThan: Date): Promise<RefundRow[]> {
    return db.query<RefundRow>(
      `SELECT * FROM payments.refunds
        WHERE tenant_id = $1
          AND (status = 'uncertain' OR (status = 'processing' AND created_at <= $2))
        ORDER BY created_at LIMIT 100`,
      [db.tenantId, olderThan],
    );
  }

  private idempotencyKey(clientRefundId: string): string {
    const principal = this.context.require().principal;
    const scope =
      principal && !isOperator(principal)
        ? (principal.deviceId ?? principal.subjectId)
        : 'operator';
    return `${scope}:${clientRefundId}`;
  }
}
