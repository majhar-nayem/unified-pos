import { randomUUID } from 'node:crypto';

import type { OrderDto } from '@pos/contracts';
import type { TenantUnitOfWork } from '@pos/db';
import type { orders } from '@pos/domain-core';
import supertest from 'supertest';

import { UnitOfWork } from '../../kernel/public/index.js';
import { OrderPortService } from '../public/index.js';
import type { OrdersWorld } from './orders-world.js';

export const line = (
  name = 'Latte',
  price = '550',
  quantity = '1',
  extra: Record<string, unknown> = {},
) => ({
  item: { name },
  listPriceMinor: price,
  quantity,
  ...extra,
});

export const ifMatch = (order: Pick<OrderDto, 'version'>) => ({ 'If-Match': `"${order.version}"` });

/** Commands through the HTTP API as `token`. */
export function client(w: OrdersWorld, token: string) {
  const auth = w.bearer(token);
  const post = (path: string, body?: object, headers: Record<string, string> = {}) =>
    w
      .api()
      .post(`/v1${path}`)
      .set(auth)
      .set(w.idem())
      .set(headers)
      .send(body ?? {});
  return {
    auth,
    get: (path: string) => w.api().get(`/v1${path}`).set(auth),
    post,
    patch: (path: string, body: object, headers: Record<string, string> = {}) =>
      w.api().patch(`/v1${path}`).set(auth).set(headers).send(body),
    delete: (path: string, headers: Record<string, string> = {}) =>
      w.api().delete(`/v1${path}`).set(auth).set(headers),
    /** Create a draft; returns the DTO. */
    async create(body: Record<string, unknown> = {}): Promise<OrderDto> {
      const res = await post('/orders', { locationId: w.locationA, ...body }).expect(201);
      return res.body as OrderDto;
    },
    async get_(orderId: string): Promise<OrderDto> {
      return (await w.api().get(`/v1/orders/${orderId}`).set(auth).expect(200)).body as OrderDto;
    },
    async place(order: OrderDto, body: object = {}): Promise<OrderDto> {
      return (await post(`/orders/${order.id}/place`, body, ifMatch(order)).expect(200))
        .body as OrderDto;
    },
  };
}

/** The OrderPort the payments module will call, run in its own system transaction (as a payment webhook would). */
export function port(w: OrdersWorld) {
  const uow = w.t.app.get(UnitOfWork);
  const svc = w.t.app.get(OrderPortService);
  const run = <T>(fn: (tx: TenantUnitOfWork, svc: OrderPortService) => Promise<T>) =>
    uow.runAs(w.tenantId, { kind: 'system' }, (tx) => fn(tx, svc));
  return {
    run,
    applyPayment: (input: orders.ApplyPaymentInput) => run((tx, s) => s.applyPayment(tx, input)),
    markPaid: (input: orders.MarkPaidInput) => run((tx, s) => s.markPaid(tx, input)),
    applyRefund: (input: orders.ApplyRefundInput) => run((tx, s) => s.applyRefund(tx, input)),
    reopenOffline: (input: orders.ReopenOfflineInput) => run((tx, s) => s.reopenOffline(tx, input)),
    totals: (orderId: string) => run((tx, s) => s.getTotals(tx, orderId)),
    /** Pay every open check in full and complete the order. */
    async settle(order: OrderDto, prefix = 'pay'): Promise<void> {
      for (const c of order.checks.filter(
        (k) => k.status === 'open' && BigInt(k.totalMinor) !== 0n,
      ))
        await run((tx, s) =>
          s.applyPayment(tx, {
            orderId: order.id,
            checkId: c.id,
            amountMinor: BigInt(c.totalMinor) - BigInt(c.paidMinor),
            paymentRef: `${prefix}-${c.id}`,
            method: 'card',
          }),
        );
      await run((tx, s) => s.markPaid(tx, { orderId: order.id, paymentRef: `${prefix}-done` }));
    },
  };
}

export async function outbox(w: OrdersWorld, aggregateId: string): Promise<string[]> {
  const rows = await w.db.admin.query<{ event_type: string }>(
    'SELECT event_type FROM audit.outbox_events WHERE tenant_id = $1 AND aggregate_id = $2 ORDER BY occurred_at, id',
    [w.tenantId, aggregateId],
  );
  return rows.rows.map((r) => r.event_type);
}

export async function auditActions(
  w: OrdersWorld,
  resourceId: string,
): Promise<Array<{ action: string; approval_id: string | null; on_behalf_of: string | null }>> {
  const rows = await w.db.admin.query<{
    action: string;
    approval_id: string | null;
    on_behalf_of: string | null;
  }>(
    'SELECT action, approval_id, on_behalf_of FROM audit.audit_log WHERE tenant_id = $1 AND resource_id = $2 ORDER BY seq',
    [w.tenantId, resourceId],
  );
  return rows.rows;
}

/**
 * Orders fixtures for the cross-tenant harness, created through the API as an all-permission caller:
 * a dine-in order with two checks, a discount, a charge and a proforma receipt. Add the result to a
 * harness fixture registry (`{ ...hierarchy, ...(await seedOrderFixtures(...)) }`); the names are the
 * `x-fixture` / `$fixture:` placeholders the orders and receipts operations declare.
 */
export async function seedOrderFixtures(args: {
  server: Parameters<typeof supertest>[0];
  /** Bearer token of a caller holding the orders permissions at the location. */
  token: string;
  locationId: string;
}): Promise<
  Record<
    'orderId' | 'checkId' | 'otherCheckId' | 'lineId' | 'discountId' | 'chargeId' | 'receiptId',
    string
  >
> {
  const send = (method: 'post', path: string, body: object, headers: Record<string, string> = {}) =>
    supertest(args.server)
      [method](`/v1${path}`)
      .set('Authorization', `Bearer ${args.token}`)
      .set('Idempotency-Key', randomUUID())
      .set(headers)
      .send(body);
  const created = (
    await send('post', '/orders', {
      locationId: args.locationId,
      kind: 'dine_in',
      lines: [
        line('Steak', '3000', '1', { seatNumber: 1 }),
        line('Salad', '1500', '1', { seatNumber: 2 }),
      ],
    }).expect(201)
  ).body as OrderDto;
  const split = (
    await send(
      'post',
      `/orders/${created.id}/checks/split`,
      { mode: 'seats', fromCheckId: created.checks[0]!.id, seatNumbers: [2] },
      ifMatch(created),
    ).expect(200)
  ).body as OrderDto;
  const discounted = (
    await send(
      'post',
      `/orders/${created.id}/discounts`,
      { description: 'Loyalty', percent: '5' },
      ifMatch(split),
    ).expect(200)
  ).body as OrderDto;
  const charged = (
    await send(
      'post',
      `/orders/${created.id}/charges`,
      { kind: 'surcharge', description: 'Fee', amountMinor: '100' },
      ifMatch(discounted),
    ).expect(200)
  ).body as OrderDto;
  const receipt = (
    await send('post', `/orders/${created.id}/receipts`, { kind: 'proforma' }).expect(201)
  ).body as { id: string };
  return {
    orderId: created.id,
    checkId: charged.checks[0]!.id,
    otherCheckId: charged.checks[1]!.id,
    lineId: charged.lines[0]!.id,
    discountId: charged.discounts[0]!.id,
    chargeId: charged.charges[0]!.id,
    receiptId: receipt.id,
  };
}
