import { randomUUID } from 'node:crypto';

import type { Pool } from '@pos/db';

export interface OrderFixture {
  readonly orderId: string;
  readonly checkId: string;
  readonly locationId: string;
}

/** An open retail order with one check (SQL fixture: payments does not import S-F4 code). */
export async function createOrderFixture(
  admin: Pool,
  tenantId: string,
  locationId: string,
  totalMinor: number,
  options: { kind?: string; status?: string } = {},
): Promise<OrderFixture> {
  const orderId = randomUUID();
  const checkId = randomUUID();
  await admin.query(
    `INSERT INTO orders.orders (id, tenant_id, location_id, business_date, kind, currency, status, subtotal_minor, total_minor)
     VALUES ($1, $2, $3, current_date, $4, 'AUD', $5, $6, $6)`,
    [
      orderId,
      tenantId,
      locationId,
      options.kind ?? 'retail_sale',
      options.status ?? 'open',
      totalMinor,
    ],
  );
  await admin.query(
    `INSERT INTO orders.checks (id, tenant_id, order_id, number, subtotal_minor, total_minor)
     VALUES ($1, $2, $3, 1, $4, $4)`,
    [checkId, tenantId, orderId, totalMinor],
  );
  return { orderId, checkId, locationId };
}

export async function readOrder(admin: Pool, orderId: string) {
  const { rows } = await admin.query(
    `SELECT o.status, o.payment_status, o.total_minor, o.paid_minor, o.refunded_minor, o.rounding_minor,
            o.settlement_pending, o.reopened_reason, o.metadata,
            c.total_minor AS check_total, c.paid_minor AS check_paid, c.rounding_minor AS check_rounding, c.status AS check_status
       FROM orders.orders o JOIN orders.checks c ON c.tenant_id = o.tenant_id AND c.order_id = o.id
      WHERE o.id = $1`,
    [orderId],
  );
  return rows[0] as {
    status: string;
    payment_status: string;
    total_minor: bigint;
    paid_minor: bigint;
    refunded_minor: bigint;
    rounding_minor: bigint;
    settlement_pending: boolean;
    reopened_reason: string | null;
    metadata: { cashTenders?: Record<string, string>[] };
    check_total: bigint;
    check_paid: bigint;
    check_rounding: bigint;
    check_status: string;
  };
}
