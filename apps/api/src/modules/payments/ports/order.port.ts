import { newId, type TenantScopedDb, type TenantUnitOfWork } from '@pos/db';

/** What payments needs to know about a check before taking money against it. */
export interface CheckForPayment {
  readonly orderId: string;
  readonly checkId: string;
  readonly locationId: string;
  readonly currency: string;
  readonly totalMinor: bigint;
  readonly paidMinor: bigint;
  readonly refundedMinor: bigint;
  readonly orderStatus: string;
  readonly checkStatus: string;
}

export interface PaymentAggregate {
  /** Σ captured_minor over the intents of the check/order. */
  readonly capturedMinor: bigint;
  /** Σ refunded_minor over the same intents. */
  readonly refundedMinor: bigint;
  /** True while any intent is an offline sale whose forward outcome is still open (docs/01 §8.3). */
  readonly settlementPending: boolean;
}

/**
 * Port to the order engine (S-F4 provides the real implementation in the integration slice).
 * Payments is the source of truth for money collected: it computes the aggregates from its own
 * intents and hands them over; the order side stores them and derives `payment_status`.
 */
export interface OrderPort {
  getCheck(
    db: TenantScopedDb,
    checkId: string,
    options?: { readonly lock?: boolean },
  ): Promise<CheckForPayment | null>;
  applyPaymentTotals(
    uow: TenantUnitOfWork,
    input: {
      readonly orderId: string;
      readonly checkId: string;
      readonly check: PaymentAggregate;
      readonly order: PaymentAggregate;
    },
  ): Promise<void>;
  /** AUD 5c rounding and the cash handed over / change given, recorded on the order and check. */
  applyCashRounding(
    uow: TenantUnitOfWork,
    input: {
      readonly orderId: string;
      readonly checkId: string;
      readonly intentId: string;
      readonly roundingMinor: bigint;
      readonly tenderedMinor: bigint;
      readonly changeMinor: bigint;
    },
  ): Promise<void>;
  /** An offline card sale was declined or expired after forwarding: reopen the check (docs/01 §8.3). */
  reopenForOfflineFailure(
    uow: TenantUnitOfWork,
    input: {
      readonly orderId: string;
      readonly checkId: string;
      readonly intentId: string;
      readonly reason: 'offline_payment_declined' | 'offline_payment_expired';
    },
  ): Promise<void>;
}

export const ORDER_PORT = Symbol('ORDER_PORT');

interface CheckRow {
  order_id: string;
  id: string;
  location_id: string;
  currency: string;
  total_minor: bigint;
  paid_minor: bigint;
  refunded_minor: bigint;
  order_status: string;
  check_status: string;
}

function paymentStatus(totalMinor: bigint, agg: PaymentAggregate): string {
  const net = agg.capturedMinor - agg.refundedMinor;
  if (agg.refundedMinor > 0n && net <= 0n) return 'refunded';
  if (agg.refundedMinor > 0n) return 'partially_refunded';
  if (totalMinor > 0n && net >= totalMinor) return 'paid';
  if (net > 0n) return 'partially_paid';
  return 'unpaid';
}

/**
 * STUB (docs/releases/s-f5.md): reads and writes the orders tables directly so payments does not
 * import S-F4 code. Replaced by the order engine's OrderPort in the Wave 2 integration slice.
 */
export class SqlOrderPortStub implements OrderPort {
  async getCheck(
    db: TenantScopedDb,
    checkId: string,
    options: { readonly lock?: boolean } = {},
  ): Promise<CheckForPayment | null> {
    const row = await db.maybeOne<CheckRow>(
      `SELECT c.order_id, c.id, o.location_id, o.currency, c.total_minor, c.paid_minor, c.refunded_minor,
              o.status AS order_status, c.status AS check_status
         FROM orders.checks c
         JOIN orders.orders o ON o.tenant_id = c.tenant_id AND o.id = c.order_id
        WHERE c.tenant_id = $1 AND c.id = $2${options.lock ? ' FOR UPDATE OF c' : ''}`,
      [db.tenantId, checkId],
    );
    if (!row) return null;
    return {
      orderId: row.order_id,
      checkId: row.id,
      locationId: row.location_id,
      currency: row.currency.trim(),
      totalMinor: row.total_minor,
      paidMinor: row.paid_minor,
      refundedMinor: row.refunded_minor,
      orderStatus: row.order_status,
      checkStatus: row.check_status,
    };
  }

  async applyPaymentTotals(
    uow: TenantUnitOfWork,
    input: {
      orderId: string;
      checkId: string;
      check: PaymentAggregate;
      order: PaymentAggregate;
    },
  ): Promise<void> {
    const db = uow.db;
    await db.query(
      `UPDATE orders.checks SET paid_minor = $3, refunded_minor = $4, version = version + 1
        WHERE tenant_id = $1 AND id = $2`,
      [db.tenantId, input.checkId, input.check.capturedMinor, input.check.refundedMinor],
    );
    const order = await db.one<{ total_minor: bigint }>(
      'SELECT total_minor FROM orders.orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
      [db.tenantId, input.orderId],
    );
    await db.query(
      `UPDATE orders.orders
          SET paid_minor = $3, refunded_minor = $4, payment_status = $5, settlement_pending = $6,
              version = version + 1
        WHERE tenant_id = $1 AND id = $2`,
      [
        db.tenantId,
        input.orderId,
        input.order.capturedMinor,
        input.order.refundedMinor,
        paymentStatus(order.total_minor, input.order),
        input.order.settlementPending,
      ],
    );
  }

  async applyCashRounding(
    uow: TenantUnitOfWork,
    input: {
      orderId: string;
      checkId: string;
      intentId: string;
      roundingMinor: bigint;
      tenderedMinor: bigint;
      changeMinor: bigint;
    },
  ): Promise<void> {
    const db = uow.db;
    const tender = JSON.stringify({
      intentId: input.intentId,
      roundingMinor: input.roundingMinor.toString(),
      tenderedMinor: input.tenderedMinor.toString(),
      changeMinor: input.changeMinor.toString(),
    });
    if (input.roundingMinor !== 0n) {
      await db.query(
        `UPDATE orders.checks SET rounding_minor = rounding_minor + $3, total_minor = total_minor + $3, version = version + 1
          WHERE tenant_id = $1 AND id = $2`,
        [db.tenantId, input.checkId, input.roundingMinor],
      );
    }
    await db.query(
      `UPDATE orders.orders
          SET rounding_minor = rounding_minor + $3, total_minor = total_minor + $3,
              metadata = jsonb_set(metadata, '{cashTenders}', COALESCE(metadata->'cashTenders', '[]'::jsonb) || $4::jsonb),
              version = version + 1
        WHERE tenant_id = $1 AND id = $2`,
      [db.tenantId, input.orderId, input.roundingMinor, `[${tender}]`],
    );
  }

  async reopenForOfflineFailure(
    uow: TenantUnitOfWork,
    input: {
      orderId: string;
      checkId: string;
      intentId: string;
      reason: 'offline_payment_declined' | 'offline_payment_expired';
    },
  ): Promise<void> {
    const db = uow.db;
    const before = await db.maybeOne<{ status: string }>(
      'SELECT status FROM orders.orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
      [db.tenantId, input.orderId],
    );
    if (!before) return;
    if (before.status === 'completed') {
      await db.query(
        `UPDATE orders.orders SET status = 'open', completed_at = NULL, reopened_at = now(), reopened_reason = $3, version = version + 1
          WHERE tenant_id = $1 AND id = $2`,
        [db.tenantId, input.orderId, input.reason],
      );
      await db.query(
        `UPDATE orders.checks SET status = 'open', closed_at = NULL, closed_by = NULL, version = version + 1
          WHERE tenant_id = $1 AND id = $2`,
        [db.tenantId, input.checkId],
      );
    }
    await db.query(
      `INSERT INTO orders.order_events (id, tenant_id, order_id, kind, from_status, to_status, payload, occurred_at)
       VALUES ($1, $2, $3, 'reopened_offline_decline', $4, $5, $6, now())`,
      [
        newId(),
        db.tenantId,
        input.orderId,
        before.status,
        before.status === 'completed' ? 'open' : before.status,
        JSON.stringify({ intentId: input.intentId, reason: input.reason }),
      ],
    );
  }
}
