import { Injectable, Inject } from '@nestjs/common';
import type { PaymentIntentStatus } from '@pos/contracts';
import { newId, type TenantScopedDb, type TenantUnitOfWork } from '@pos/db';
import { redactForStorage } from '@pos/payments-sdk';

import { ConflictError } from '../kernel/public/index.js';
import { ORDER_PORT, type OrderPort, type PaymentAggregate } from './ports/order.port.js';
import { type AttemptRow, type CardRow, type IntentRow, type RefundRow } from './rows.js';
import {
  InvalidTransitionError,
  assertTransition,
  type TransitionContext,
} from './domain/state-machine.js';

export type EventSource =
  'pos' | 'api' | 'provider_webhook' | 'terminal' | 'reconciliation' | 'admin' | 'system';

export interface Caller {
  readonly source: EventSource;
  readonly actorUserId?: string | null;
  readonly deviceId?: string | null;
}

/** Column patches the ledger may apply together with a status transition. */
export interface IntentPatch {
  providerReference?: string | null;
  authorizedMinor?: bigint;
  capturedMinor?: bigint;
  refundedMinor?: bigint;
  tipMinor?: bigint;
  offline?: boolean;
  settlementPending?: boolean;
  settlementStatus?: 'unsettled' | 'settled' | 'disputed' | 'not_applicable';
  offlineCollectedAt?: Date | null;
  offlineExpiresAt?: Date | null;
  offlineDeviceSeq?: number | null;
  forwardedAt?: Date | null;
  forwardOutcome?: 'pending' | 'approved' | 'declined' | 'expired' | 'rescue_in_progress' | null;
  lastError?: Record<string, unknown> | null;
  terminalId?: string | null;
}

const PATCH_COLUMNS: Readonly<Record<keyof IntentPatch, { column: string; json?: boolean }>> = {
  providerReference: { column: 'provider_reference' },
  authorizedMinor: { column: 'authorized_minor' },
  capturedMinor: { column: 'captured_minor' },
  refundedMinor: { column: 'refunded_minor' },
  tipMinor: { column: 'tip_minor' },
  offline: { column: 'offline' },
  settlementPending: { column: 'settlement_pending' },
  settlementStatus: { column: 'settlement_status' },
  offlineCollectedAt: { column: 'offline_collected_at' },
  offlineExpiresAt: { column: 'offline_expires_at' },
  offlineDeviceSeq: { column: 'offline_device_seq' },
  forwardedAt: { column: 'forwarded_at' },
  forwardOutcome: { column: 'forward_outcome' },
  lastError: { column: 'last_error', json: true },
  terminalId: { column: 'terminal_id' },
};

export interface EventInput {
  readonly kind: string;
  readonly from?: PaymentIntentStatus | null;
  readonly to?: PaymentIntentStatus | null;
  readonly amountMinor?: bigint | null;
  readonly payload?: Record<string, unknown>;
  readonly attemptId?: string | null;
  readonly occurredAt?: Date;
}

/**
 * The only writer of payment status, attempts and events (docs/01 §7.3: `payment_events` is the
 * append-only audit of record, `payment_intents.status` a projection). Every method runs inside
 * the caller's unit of work.
 */
@Injectable()
export class PaymentsLedger {
  constructor(@Inject(ORDER_PORT) private readonly orders: OrderPort) {}

  async lockIntent(db: TenantScopedDb, id: string): Promise<IntentRow | null> {
    return db.maybeOne<IntentRow>(
      'SELECT * FROM payments.payment_intents WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
      [db.tenantId, id],
    );
  }

  async getIntent(db: TenantScopedDb, id: string): Promise<IntentRow | null> {
    return db.maybeOne<IntentRow>(
      'SELECT * FROM payments.payment_intents WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, id],
    );
  }

  async getCard(db: TenantScopedDb, intentId: string): Promise<CardRow | null> {
    return db.maybeOne<CardRow>(
      'SELECT * FROM payments.card_payment_details WHERE tenant_id = $1 AND intent_id = $2',
      [db.tenantId, intentId],
    );
  }

  async insertEvent(
    db: TenantScopedDb,
    intentId: string,
    caller: Caller,
    input: EventInput,
  ): Promise<void> {
    await db.query(
      `INSERT INTO payments.payment_events
         (id, tenant_id, intent_id, attempt_id, kind, from_status, to_status, source, amount_minor, payload,
          actor_user_id, device_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        newId(),
        db.tenantId,
        intentId,
        input.attemptId ?? null,
        input.kind,
        input.from ?? null,
        input.to ?? null,
        caller.source,
        input.amountMinor ?? null,
        JSON.stringify(redactForStorage(input.payload ?? {})),
        caller.actorUserId ?? null,
        caller.deviceId ?? null,
        input.occurredAt ?? new Date(),
      ],
    );
  }

  /**
   * Move an intent to a new status in one statement guarded by the status the caller saw
   * (optimistic: a concurrent transition makes this throw rather than overwrite), apply the column
   * patch, bump the version and append the event.
   */
  async transition(
    uow: TenantUnitOfWork,
    intent: IntentRow,
    to: PaymentIntentStatus,
    caller: Caller,
    event: Omit<EventInput, 'from' | 'to'>,
    patch: IntentPatch = {},
    context: TransitionContext = {},
  ): Promise<IntentRow> {
    assertTransition(intent.status, to, context);
    const updated = await this.update(uow.db, intent, to, patch);
    await this.insertEvent(uow.db, intent.id, caller, { ...event, from: intent.status, to });
    return updated;
  }

  /** Record something on the intent without changing its status (refund applied, webhook seen, …). */
  async annotate(
    uow: TenantUnitOfWork,
    intent: IntentRow,
    caller: Caller,
    event: Omit<EventInput, 'from' | 'to'>,
    patch: IntentPatch = {},
  ): Promise<IntentRow> {
    const updated = Object.keys(patch).length
      ? await this.update(uow.db, intent, intent.status, patch)
      : intent;
    await this.insertEvent(uow.db, intent.id, caller, {
      ...event,
      from: intent.status,
      to: intent.status,
    });
    return updated;
  }

  private async update(
    db: TenantScopedDb,
    intent: IntentRow,
    to: PaymentIntentStatus,
    patch: IntentPatch,
  ): Promise<IntentRow> {
    const sets = ['status = $4', 'version = version + 1'];
    const params: unknown[] = [db.tenantId, intent.id, intent.status, to];
    for (const [key, value] of Object.entries(patch) as [keyof IntentPatch, unknown][]) {
      if (value === undefined) continue;
      const spec = PATCH_COLUMNS[key];
      params.push(spec.json && value !== null ? JSON.stringify(value) : value);
      sets.push(`${spec.column} = $${params.length}`);
    }
    const rows = await db.query<IntentRow>(
      `UPDATE payments.payment_intents SET ${sets.join(', ')}
        WHERE tenant_id = $1 AND id = $2 AND status = $3 RETURNING *`,
      params,
    );
    if (!rows[0])
      throw new ConflictError(
        'INTENT_CHANGED_CONCURRENTLY',
        `Payment intent ${intent.id} was no longer ${intent.status}`,
      );
    return rows[0];
  }

  // --- attempts ------------------------------------------------------------

  async startAttempt(
    db: TenantScopedDb,
    intentId: string,
    input: {
      operation: AttemptRow['operation'];
      providerIdempotencyKey: string | null;
      request: unknown;
    },
  ): Promise<AttemptRow> {
    const next = await db.one<{ n: number }>(
      `SELECT COALESCE(MAX(attempt_no), 0) + 1 AS n FROM payments.payment_attempts
        WHERE tenant_id = $1 AND intent_id = $2`,
      [db.tenantId, intentId],
    );
    return db.one<AttemptRow>(
      `INSERT INTO payments.payment_attempts
         (id, tenant_id, intent_id, attempt_no, operation, provider_idempotency_key, status, request_redacted)
       VALUES ($1, $2, $3, $4, $5, $6, 'started', $7) RETURNING *`,
      [
        newId(),
        db.tenantId,
        intentId,
        next.n,
        input.operation,
        input.providerIdempotencyKey,
        JSON.stringify(redactForStorage(input.request)),
      ],
    );
  }

  async finishAttempt(
    db: TenantScopedDb,
    attemptId: string,
    input: {
      status: AttemptRow['status'];
      response?: unknown;
      errorCode?: string | null;
      errorMessage?: string | null;
      providerRequestId?: string | null;
    },
  ): Promise<void> {
    await db.query(
      `UPDATE payments.payment_attempts
          SET status = $3, response_redacted = $4, error_code = $5, error_message = $6,
              provider_request_id = COALESCE($7, provider_request_id), finished_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [
        db.tenantId,
        attemptId,
        input.status,
        input.response === undefined ? null : JSON.stringify(redactForStorage(input.response)),
        input.errorCode ?? null,
        input.errorMessage ? String(redactForStorage(input.errorMessage)).slice(0, 1000) : null,
        input.providerRequestId ?? null,
      ],
    );
  }

  async openAttempt(db: TenantScopedDb, intentId: string): Promise<AttemptRow | null> {
    return db.maybeOne<AttemptRow>(
      `SELECT * FROM payments.payment_attempts
        WHERE tenant_id = $1 AND intent_id = $2 AND status = 'started'
        ORDER BY attempt_no DESC LIMIT 1`,
      [db.tenantId, intentId],
    );
  }

  // --- card details --------------------------------------------------------

  async saveCardDetails(
    db: TenantScopedDb,
    intentId: string,
    card: {
      cardBrand?: string | null;
      last4?: string | null;
      entryMode?: string | null;
      authCode?: string | null;
      aid?: string | null;
      applicationLabel?: string | null;
      tokenRef?: string | null;
      schemeReference?: string | null;
      cardholderVerification?: string | null;
      issuerBank?: string | null;
      terminalReceiptText?: string | null;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO payments.card_payment_details
         (intent_id, tenant_id, card_brand, last4, entry_mode, auth_code, aid, application_label, token_ref,
          scheme_reference, cardholder_verification, issuer_bank, terminal_receipt_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (intent_id) DO UPDATE SET
         card_brand = COALESCE(EXCLUDED.card_brand, payments.card_payment_details.card_brand),
         last4 = COALESCE(EXCLUDED.last4, payments.card_payment_details.last4),
         entry_mode = COALESCE(EXCLUDED.entry_mode, payments.card_payment_details.entry_mode),
         auth_code = COALESCE(EXCLUDED.auth_code, payments.card_payment_details.auth_code),
         aid = COALESCE(EXCLUDED.aid, payments.card_payment_details.aid),
         application_label = COALESCE(EXCLUDED.application_label, payments.card_payment_details.application_label),
         token_ref = COALESCE(EXCLUDED.token_ref, payments.card_payment_details.token_ref),
         scheme_reference = COALESCE(EXCLUDED.scheme_reference, payments.card_payment_details.scheme_reference),
         cardholder_verification = COALESCE(EXCLUDED.cardholder_verification, payments.card_payment_details.cardholder_verification),
         issuer_bank = COALESCE(EXCLUDED.issuer_bank, payments.card_payment_details.issuer_bank),
         terminal_receipt_text = COALESCE(EXCLUDED.terminal_receipt_text, payments.card_payment_details.terminal_receipt_text)`,
      [
        intentId,
        db.tenantId,
        card.cardBrand ?? null,
        card.last4 ?? null,
        card.entryMode ?? null,
        card.authCode ?? null,
        card.aid ?? null,
        card.applicationLabel ?? null,
        card.tokenRef ?? null,
        card.schemeReference ?? null,
        card.cardholderVerification ?? null,
        card.issuerBank ?? null,
        card.terminalReceiptText ? String(redactForStorage(card.terminalReceiptText)) : null,
      ],
    );
  }

  // --- order totals --------------------------------------------------------

  /** Money collected is derived from the intents themselves, then handed to the order side. */
  async syncOrder(
    uow: TenantUnitOfWork,
    intent: Pick<IntentRow, 'order_id' | 'check_id'>,
  ): Promise<void> {
    const db = uow.db;
    const aggregate = async (
      column: 'check_id' | 'order_id',
      id: string,
    ): Promise<PaymentAggregate> => {
      const row = await db.one<{ captured: bigint; refunded: bigint; pending: boolean }>(
        `SELECT COALESCE(SUM(captured_minor), 0)::bigint AS captured,
                COALESCE(SUM(refunded_minor), 0)::bigint AS refunded,
                COALESCE(bool_or(offline AND forward_outcome IN ('pending','rescue_in_progress') AND status IN ('captured','partially_refunded','refunded')), false) AS pending
           FROM payments.payment_intents
          WHERE tenant_id = $1 AND ${column} = $2`,
        [db.tenantId, id],
      );
      return {
        capturedMinor: row.captured,
        refundedMinor: row.refunded,
        settlementPending: row.pending,
      };
    };
    await this.orders.applyPaymentTotals(uow, {
      orderId: intent.order_id,
      checkId: intent.check_id,
      check: await aggregate('check_id', intent.check_id),
      order: await aggregate('order_id', intent.order_id),
    });
  }

  // --- outbox --------------------------------------------------------------

  emit(
    uow: TenantUnitOfWork,
    type: 'payment.authorized' | 'payment.captured' | 'payment.failed' | 'refund.succeeded',
    intent: IntentRow,
    extra: Record<string, unknown> = {},
  ): void {
    uow.emit({
      type,
      aggregateKind: 'payment_intent',
      aggregateId: intent.id,
      aggregateVersion: intent.version,
      locationId: intent.location_id,
      payload: {
        intentId: intent.id,
        orderId: intent.order_id,
        checkId: intent.check_id,
        method: intent.method,
        currency: intent.currency.trim(),
        amountMinor: intent.amount_minor.toString(),
        capturedMinor: intent.captured_minor.toString(),
        refundedMinor: intent.refunded_minor.toString(),
        ...extra,
      },
    });
  }

  // --- exceptions ----------------------------------------------------------

  /** Raise a reconciliation exception unless an open one for the same kind and subject already exists. */
  async raiseException(
    db: TenantScopedDb,
    input: {
      kind: string;
      severity: 'low' | 'medium' | 'high' | 'critical';
      subjectKind: string;
      subjectId: string;
      details: Record<string, unknown>;
    },
  ): Promise<boolean> {
    const existing = await db.maybeOne<{ id: string }>(
      `SELECT id FROM payments.reconciliation_exceptions
        WHERE tenant_id = $1 AND domain = 'payments' AND kind = $2 AND subject_id = $3
          AND status IN ('open','investigating') LIMIT 1`,
      [db.tenantId, input.kind, input.subjectId],
    );
    if (existing) return false;
    await db.query(
      `INSERT INTO payments.reconciliation_exceptions
         (id, tenant_id, domain, kind, severity, subject_kind, subject_id, details)
       VALUES ($1, $2, 'payments', $3, $4, $5, $6, $7)`,
      [
        newId(),
        db.tenantId,
        input.kind,
        input.severity,
        input.subjectKind,
        input.subjectId,
        JSON.stringify(redactForStorage(input.details)),
      ],
    );
    return true;
  }

  async getRefund(db: TenantScopedDb, id: string): Promise<RefundRow | null> {
    return db.maybeOne<RefundRow>(
      'SELECT * FROM payments.refunds WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, id],
    );
  }
}

export { InvalidTransitionError };
