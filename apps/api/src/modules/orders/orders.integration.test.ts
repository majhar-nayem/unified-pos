import { randomUUID } from 'node:crypto';

import type { OrderDto } from '@pos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { auditActions, client, ifMatch, line, outbox, port } from './testing/helpers.js';
import { buildOrdersWorld, type OrdersWorld } from './testing/orders-world.js';

describe('orders: create, lines, lifecycle (F4 acceptance)', () => {
  let w: OrdersWorld;
  beforeAll(async () => {
    w = await buildOrdersWorld();
  }, 240_000);
  afterAll(async () => {
    await w?.close();
  });

  const cashier = () => client(w, w.cashier.token);
  const manager = () => client(w, w.manager.token);
  const owner = () => client(w, w.ownerToken);

  it('a cashier builds an order: GST-inclusive totals, tax rows, ETag = version', async () => {
    const order = await cashier().create({
      lines: [line('Latte', '550', '2'), line('Muffin', '450')],
    });
    expect(order).toMatchObject({
      status: 'draft',
      fulfillmentStatus: 'unfulfilled',
      paymentStatus: 'unpaid',
      kind: 'retail_sale',
      currency: 'AUD',
      pricingMode: 'tax_inclusive',
      orderNumber: null,
      subtotalMinor: '1550',
      taxMinor: '141',
      totalMinor: '1550',
      version: 1,
    });
    expect(order.lines.map((l) => [l.seq, l.quantity, l.totalMinor, l.taxMinor])).toEqual([
      [1, '2.0000', '1100', '100'],
      [2, '1.0000', '450', '41'],
    ]);
    expect(order.lines[0]!.taxes[0]).toMatchObject({
      taxName: 'GST',
      rate: '0.100000',
      taxableMinor: '1000',
      taxMinor: '100',
      inclusive: true,
    });
    expect(order.checks).toHaveLength(1);
    const got = await cashier().get(`/orders/${order.id}`).expect(200);
    expect(got.headers.etag).toBe('"1"');
    expect(got.body).toEqual(order);
  });

  it('create validates the request and the caller’s reach', async () => {
    const c = cashier();
    await c.post('/orders', { locationId: w.locationA, kind: 'return' }).expect(422);
    await c.post('/orders', { locationId: w.locationA, lines: [{ quantity: '1' }] }).expect(422); // no item, no price
    await c.post('/orders', { locationId: w.locationA, lines: [line('X', '-5')] }).expect(422);
    await c.post('/orders', { locationId: w.locationA, lines: [line('X', '5', '0')] }).expect(422);
    await c.post('/orders', { locationId: w.locationA, clientOrderRef: 'has space' }).expect(422);
    // a register belongs to its own location, and must exist
    const ok = await c
      .post('/orders', { locationId: w.locationA, registerId: w.registerA })
      .expect(201);
    expect(ok.body.registerId).toBe(w.registerA);
    await client(w, w.cashierB.token)
      .post('/orders', { locationId: w.locationB, registerId: w.registerA })
      .expect(404);
    await c.post('/orders', { locationId: w.locationA, registerId: randomUUID() }).expect(404);
    await w
      .api()
      .post('/v1/orders')
      .set(w.bearer(w.cashier.token))
      .send({ locationId: w.locationA })
      .expect(400); // Idempotency-Key required
    await w.api().post('/v1/orders').set(w.idem()).send({ locationId: w.locationA }).expect(401);
    // location B is outside the cashier's reach: indistinguishable from "does not exist"
    await c.post('/orders', { locationId: w.locationB }).expect(404);
    await c.post('/orders', { locationId: randomUUID() }).expect(404);
  });

  it('a cashier at location A cannot see, change or list location B orders (and vice versa)', async () => {
    const mine = await cashier().create();
    const theirs = await client(w, w.cashierB.token).create({ locationId: w.locationB });
    await cashier().get(`/orders/${theirs.id}`).expect(404);
    await cashier().post(`/orders/${theirs.id}/lines`, line(), {}).expect(404);
    await client(w, w.cashierB.token).get(`/orders/${mine.id}`).expect(404);
    await cashier().get(`/orders?locationId=${w.locationB}`).expect(404);
    const list = await cashier().get(`/orders?locationId=${w.locationA}`).expect(200);
    expect(list.body.items.map((o: { id: string }) => o.id)).toContain(mine.id);
    expect(list.body.items.map((o: { id: string }) => o.id)).not.toContain(theirs.id);
  });

  it('a foreign tenant sees nothing (404 everywhere), even with a valid id', async () => {
    const order = await cashier().create({ lines: [line()] });
    const f = client(w, w.foreign.token);
    await f.get(`/orders/${order.id}`).expect(404);
    await f.get(`/orders/${order.id}/events`).expect(404);
    await f.post(`/orders/${order.id}/lines`, line()).expect(404);
    await f.post(`/orders/${order.id}/place`, {}, ifMatch(order)).expect(404);
    await f.post(`/orders/${order.id}/receipts`, { kind: 'proforma' }).expect(404);
    await f.get(`/orders?locationId=${w.locationA}`).expect(404);
    await f.post('/orders', { locationId: w.locationA }).expect(404);
  });

  it('Idempotency-Key: the same request replays the same response; a different body with the key is refused', async () => {
    const key = { 'Idempotency-Key': randomUUID() };
    const body = { locationId: w.locationA, lines: [line('Tea', '400')] };
    const first = await w
      .api()
      .post('/v1/orders')
      .set(w.bearer(w.cashier.token))
      .set(key)
      .send(body)
      .expect(201);
    const second = await w
      .api()
      .post('/v1/orders')
      .set(w.bearer(w.cashier.token))
      .set(key)
      .send(body)
      .expect(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    const other = await w
      .api()
      .post('/v1/orders')
      .set(w.bearer(w.cashier.token))
      .set(key)
      .send({ ...body, notes: 'different' })
      .expect(422);
    expect(other.body.error.message).toMatch(/different request/);
    const rows = await w.db.admin.query('SELECT 1 FROM orders.orders WHERE id = $1', [
      first.body.id,
    ]);
    expect(rows.rowCount).toBe(1);

    // a line add replayed does not add twice
    const lineKey = { 'Idempotency-Key': randomUUID() };
    const add = () =>
      w
        .api()
        .post(`/v1/orders/${first.body.id}/lines`)
        .set(w.bearer(w.cashier.token))
        .set(lineKey)
        .send(line('Scone', '350'));
    const a1 = await add().expect(200);
    const a2 = await add().expect(200);
    expect(a2.headers['idempotency-replayed']).toBe('true');
    expect(a2.body).toEqual(a1.body);
    expect((await cashier().get_(first.body.id)).lines).toHaveLength(2);
  });

  it('creating twice with the same clientOrderRef returns the same order (offline register retry)', async () => {
    const body = {
      clientOrderRef: 'R1-000123',
      clientCreatedAt: '2026-10-18T05:00:00Z',
      lines: [line()],
    };
    const a = await cashier()
      .post('/orders', { locationId: w.locationA, ...body })
      .expect(201);
    const b = await cashier()
      .post('/orders', { locationId: w.locationA, ...body })
      .expect(201);
    expect(b.body.id).toBe(a.body.id);
    const count = await w.db.admin.query(
      "SELECT 1 FROM orders.orders WHERE client_order_ref = 'R1-000123' AND location_id = $1",
      [w.locationA],
    );
    expect(count.rowCount).toBe(1);
    expect(a.body).toMatchObject({
      clientOrderRef: 'R1-000123',
      clientCreatedAt: '2026-10-18T05:00:00.000Z',
      businessDate: '2026-10-18',
    });
  });

  it('If-Match: required on edits (428), stale versions are refused (412) and change nothing', async () => {
    const order = await cashier().create({ lines: [line('A', '1000')] });
    const lineId = order.lines[0]!.id;
    await cashier().patch(`/orders/${order.id}/lines/${lineId}`, { quantity: '2' }).expect(428);
    const ok = await cashier()
      .patch(`/orders/${order.id}/lines/${lineId}`, { quantity: '2' }, ifMatch(order))
      .expect(200);
    expect(ok.body).toMatchObject({ version: 2, totalMinor: '2000' });
    expect(ok.headers.etag).toBe('"2"');
    const stale = await cashier()
      .patch(`/orders/${order.id}/lines/${lineId}`, { quantity: '9' }, ifMatch(order))
      .expect(412);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect((await cashier().get_(order.id)).lines[0]!.quantity).toBe('2.0000');
  });

  it('50 parallel line adds on one order serialise on the order: 50 lines, versions 2..51, no lost update', async () => {
    const order = await cashier().create();
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        cashier()
          .post(`/orders/${order.id}/lines`, line(`Item ${i}`, '100'))
          .then((r) => r),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(50).fill(200));
    const versions = results.map((r) => r.body.version as number).sort((a, b) => a - b);
    expect(versions).toEqual(Array.from({ length: 50 }, (_, i) => i + 2));
    const final = await cashier().get_(order.id);
    expect(final).toMatchObject({
      version: 51,
      totalMinor: '5000',
      subtotalMinor: '5000',
      taxMinor: '450',
    });
    expect(final.lines.map((l) => l.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(new Set(final.lines.map((l) => l.id)).size).toBe(50);
    const events = await w.db.admin.query(
      "SELECT 1 FROM orders.order_events WHERE order_id = $1 AND kind = 'line_added'",
      [order.id],
    );
    expect(events.rowCount).toBe(50);
  }, 120_000);

  it('with If-Match, parallel adds from one version: exactly one wins, the rest get 412', async () => {
    const order = await cashier().create({ lines: [line('Seed', '100')] });
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        cashier().post(`/orders/${order.id}/lines`, line(`Race ${i}`, '100'), ifMatch(order)),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, ...Array(11).fill(412)]);
    expect((await cashier().get_(order.id)).lines).toHaveLength(2);
  }, 60_000);

  it('place assigns the canonical number; suspend/resume; edits stop where the status says', async () => {
    const draft = await cashier().create({ lines: [line('A', '1000'), line('B', '500')] });
    await cashier().post(`/orders/${draft.id}/suspend`, {}, ifMatch(draft)).expect(409); // a draft is placed first
    const placed = await cashier().place(draft);
    expect(placed).toMatchObject({ status: 'open', orderNumber: expect.any(Number), version: 2 });
    expect(placed.placedAt).not.toBeNull();
    await cashier().post(`/orders/${draft.id}/place`, {}, ifMatch(placed)).expect(409);

    const suspended = (
      await cashier()
        .post(`/orders/${draft.id}/suspend`, { reason: 'fetching wallet' }, ifMatch(placed))
        .expect(200)
    ).body as OrderDto;
    expect(suspended.status).toBe('suspended');
    const add = await cashier().post(`/orders/${draft.id}/lines`, line('C', '100')).expect(409);
    expect(add.body.error.code).toBe('ORDER_NOT_EDITABLE');
    await cashier().post(`/orders/${draft.id}/suspend`, {}, ifMatch(suspended)).expect(409);
    const resumed = (
      await cashier().post(`/orders/${draft.id}/resume`, {}, ifMatch(suspended)).expect(200)
    ).body as OrderDto;
    expect(resumed.status).toBe('open');
    await cashier().post(`/orders/${draft.id}/lines`, line('C', '100')).expect(200);

    // empty drafts are not placed
    const empty = await cashier().create();
    const refused = await cashier()
      .post(`/orders/${empty.id}/place`, {}, ifMatch(empty))
      .expect(409);
    expect(refused.body.error.code).toBe('EMPTY_ORDER');

    const events = (await cashier().get(`/orders/${draft.id}/events`).expect(200)).body as Array<{
      kind: string;
      fromStatus: string | null;
      toStatus: string | null;
    }>;
    expect(events.map((e) => e.kind)).toEqual([
      'created',
      'line_added',
      'line_added',
      'placed',
      'suspended',
      'resumed',
      'line_added',
    ]);
    expect(events.find((e) => e.kind === 'placed')).toMatchObject({
      fromStatus: 'draft',
      toStatus: 'open',
    });
    expect(await outbox(w, draft.id)).toEqual(['order.placed']);
  });

  it('order numbers are per location and business date (location time zone and day boundary), gap-free, and restart each day', async () => {
    // Sydney is UTC+10 in July; the trading day starts at 04:00 local, so 17:59Z (03:59 on the 18th) still belongs to the 17th
    const placeAt = async (token: string, locationId: string, clientCreatedAt: string) => {
      const c = client(w, token);
      return c.place(await c.create({ locationId, clientCreatedAt, lines: [line()] }));
    };
    const a1 = await placeAt(w.cashier.token, w.locationA, '2026-07-17T17:59:00Z');
    const a2 = await placeAt(w.cashier.token, w.locationA, '2026-07-17T10:00:00Z');
    const a3 = await placeAt(w.cashier.token, w.locationA, '2026-07-17T18:01:00Z');
    expect(a1.businessDate).toBe('2026-07-17');
    expect(a3.businessDate).toBe('2026-07-18');
    expect([a1.orderNumber, a2.orderNumber]).toEqual([1, 2]);
    expect(a3.orderNumber).toBe(1);
    // Perth (UTC+8): 20:30Z is 04:30 on the 18th, 19:30Z is 03:30 (still the 17th); its own sequence
    const b1 = await placeAt(w.cashierB.token, w.locationB, '2026-07-17T20:30:00Z');
    const b0 = await placeAt(w.cashierB.token, w.locationB, '2026-07-17T19:30:00Z');
    expect([b1.businessDate, b1.orderNumber]).toEqual(['2026-07-18', 1]);
    expect([b0.businessDate, b0.orderNumber]).toEqual(['2026-07-17', 1]);
    const seq = await w.db.admin.query<{ next_value: number }>(
      "SELECT next_value FROM orders.order_number_sequences WHERE location_id = $1 AND business_date = '2026-07-17'",
      [w.locationA],
    );
    expect(seq.rows[0]!.next_value).toBe(3);
  });

  it('50 parallel placements at one location take 50 distinct numbers', async () => {
    const drafts = await Promise.all(
      Array.from({ length: 50 }, () =>
        cashier().create({ clientCreatedAt: '2026-09-01T05:00:00Z', lines: [line()] }),
      ),
    );
    const placed = await Promise.all(
      drafts.map((d) => cashier().post(`/orders/${d.id}/place`, {}, ifMatch(d)).expect(200)),
    );
    const numbers = placed.map((p) => p.body.orderNumber as number).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  }, 120_000);

  it('lines: update, remove (draft), void (placed, orders.line.void or approval), kitchen lock', async () => {
    const draft = await cashier().create({
      kind: 'dine_in',
      lines: [line('Soup', '900'), line('Bread', '300')],
    });
    const [soup, bread] = draft.lines;
    const removed = (
      await cashier().delete(`/orders/${draft.id}/lines/${bread!.id}`, ifMatch(draft)).expect(200)
    ).body as OrderDto;
    expect(removed.lines.map((l) => l.item.name)).toEqual(['Soup']);
    expect(removed.totalMinor).toBe('900');
    const placed = await cashier().place(removed);
    // a placed order keeps the row; removal is refused, void needs orders.line.void
    await cashier().delete(`/orders/${draft.id}/lines/${soup!.id}`, ifMatch(placed)).expect(409);
    const denied = await cashier()
      .post(
        `/orders/${draft.id}/lines/${soup!.id}/void`,
        { reason: 'wrong table' },
        ifMatch(placed),
      )
      .expect(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    const voided = (
      await manager()
        .post(
          `/orders/${draft.id}/lines/${soup!.id}/void`,
          { reason: 'wrong table' },
          ifMatch(placed),
        )
        .expect(200)
    ).body as OrderDto;
    expect(voided.lines[0]).toMatchObject({
      status: 'voided',
      voidReason: 'wrong table',
      voidedBy: w.manager.id,
      kitchenStatus: 'not_sent',
    });
    expect(voided.totalMinor).toBe('0');
    expect(voided.lines).toHaveLength(1);
    await manager()
      .post(`/orders/${draft.id}/lines/${soup!.id}/void`, { reason: 'again' }, ifMatch(voided))
      .expect(409);
    await manager()
      .post(`/orders/${draft.id}/lines/${soup!.id}/void`, {}, ifMatch(voided))
      .expect(422);
  });

  it('a manager voids a line with an approval a cashier carries; the approval is consumed once and only for that line', async () => {
    const order = await owner().create({
      kind: 'dine_in',
      lines: [line('Steak', '3000'), line('Wine', '1200')],
    });
    const placed = await owner().place(order);
    const [steak, wine] = placed.lines;
    const request = (lineId: string) =>
      cashier()
        .post('/approvals', {
          kind: 'void',
          locationId: w.locationA,
          subjectKind: 'order_line',
          subjectId: lineId,
          payload: { permission: 'orders.line.void', orderId: order.id, orderLineId: lineId },
        })
        .expect(201);
    const approve = (id: string, pin = w.managerPin, userId = w.manager.id) =>
      cashier().post(`/approvals/${id}/approve`, { factor: { kind: 'pin', userId, pin } });
    const forSteak = (await request(steak!.id)).body.id as string;
    await approve(forSteak).expect(200);

    // the approval names the steak: using it for the wine is refused and changes nothing
    const wrong = await cashier()
      .post(
        `/orders/${order.id}/lines/${wine!.id}/void`,
        { reason: 'no', approvalId: forSteak },
        ifMatch(placed),
      )
      .expect(409);
    expect(wrong.body.error.code).toBe('APPROVAL_PAYLOAD_MISMATCH');
    expect((await cashier().get_(order.id)).lines.every((l) => l.status === 'active')).toBe(true);

    const done = (
      await cashier()
        .post(
          `/orders/${order.id}/lines/${steak!.id}/void`,
          { reason: 'overcooked', approvalId: forSteak },
          ifMatch(placed),
        )
        .expect(200)
    ).body as OrderDto;
    expect(done.lines[0]).toMatchObject({
      status: 'voided',
      voidApprovalId: forSteak,
      voidedBy: w.cashier.id,
    });
    expect(done.totalMinor).toBe('1200');
    const used = await w.db.admin.query<{ status: string }>(
      'SELECT status FROM identity.approval_requests WHERE id = $1',
      [forSteak],
    );
    expect(used.rows[0]!.status).toBe('consumed');
    const audit = await auditActions(w, order.id);
    expect(audit.find((a) => a.action === 'orders.order.line_voided')).toMatchObject({
      approval_id: forSteak,
      on_behalf_of: w.manager.id,
    });
    // reuse: refused
    await cashier()
      .post(
        `/orders/${order.id}/lines/${wine!.id}/void`,
        { reason: 'x', approvalId: forSteak },
        ifMatch(done),
      )
      .expect(409);
    // an approval nobody granted is not an approval
    const pending = (await request(wine!.id)).body.id as string;
    const notYet = await cashier()
      .post(
        `/orders/${order.id}/lines/${wine!.id}/void`,
        { reason: 'x', approvalId: pending },
        ifMatch(done),
      )
      .expect(409);
    expect(notYet.body.error.code).toBe('APPROVAL_NOT_APPROVED');
  });

  it('voids require orders.void or an approval; a draft is simply discarded; completed orders become voided', async () => {
    // discard a draft: orders.create is enough
    const scratch = await cashier().create({ lines: [line()] });
    const gone = (
      await cashier()
        .post(`/orders/${scratch.id}/void`, { reason: 'customer left' }, ifMatch(scratch))
        .expect(200)
    ).body as OrderDto;
    expect(gone).toMatchObject({ status: 'cancelled', voidReason: 'customer left' });
    expect(gone.lines.every((l) => l.status === 'cancelled')).toBe(true);
    expect(await outbox(w, scratch.id)).toEqual([]); // never placed: nothing to tell anyone

    // a completed sale
    const sale = await owner().create({ lines: [line('Jacket', '12000')] });
    const placed = await owner().place(sale);
    await port(w).settle(placed);
    const completed = await owner().get_(sale.id);
    expect(completed).toMatchObject({
      status: 'completed',
      paymentStatus: 'paid',
      fulfillmentStatus: 'fulfilled',
    });
    expect(await outbox(w, sale.id)).toEqual(['order.placed', 'order.completed']);

    // the cashier has no orders.void
    const denied = await cashier()
      .post(`/orders/${sale.id}/void`, { reason: 'duplicate' }, ifMatch(completed))
      .expect(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    // …but carries an approval the manager granted for exactly this order
    const approval = (
      await cashier()
        .post('/approvals', {
          kind: 'void',
          locationId: w.locationA,
          subjectKind: 'order',
          subjectId: sale.id,
          payload: { permission: 'orders.void', orderId: sale.id },
        })
        .expect(201)
    ).body.id as string;
    // the shipped shift_supervisor role holds orders.void, so a supervisor's PIN at the register is enough
    await cashier()
      .post(`/approvals/${approval}/approve`, {
        factor: { kind: 'pin', userId: w.supervisor.id, pin: w.supervisorPin },
      })
      .expect(200);
    const voided = (
      await cashier()
        .post(
          `/orders/${sale.id}/void`,
          { reason: 'duplicate sale', approvalId: approval },
          ifMatch(completed),
        )
        .expect(200)
    ).body as OrderDto;
    expect(voided).toMatchObject({
      status: 'voided',
      voidReason: 'duplicate sale',
      voidApprovalId: approval,
      paymentStatus: 'paid',
    });
    expect(voided.voidedAt).not.toBeNull();
    expect(await outbox(w, sale.id)).toEqual(['order.placed', 'order.completed', 'order.voided']);
    const events = (await owner().get(`/orders/${sale.id}/events`).expect(200)).body as Array<{
      kind: string;
      approvalId: string | null;
    }>;
    expect(events.at(-1)).toMatchObject({ kind: 'voided', approvalId: approval });
    const audit = await auditActions(w, sale.id);
    expect(audit.at(-1)).toMatchObject({
      action: 'orders.order.voided',
      approval_id: approval,
      on_behalf_of: w.supervisor.id,
    });
    await manager()
      .post(`/orders/${sale.id}/void`, { reason: 'again' }, ifMatch(voided))
      .expect(409);

    // a manager holds orders.void themselves
    const second = await owner().create({ lines: [line('Hat', '3000')] });
    const secondPlaced = await owner().place(second);
    const cancelled = (
      await manager()
        .post(`/orders/${second.id}/void`, { reason: 'wrong customer' }, ifMatch(secondPlaced))
        .expect(200)
    ).body as OrderDto;
    expect(cancelled.status).toBe('cancelled');
    expect(await outbox(w, second.id)).toEqual(['order.placed', 'order.voided']);
    // an approval for another order is refused
    const third = await owner().create({ lines: [line('Cap', '2500')] });
    const thirdPlaced = await owner().place(third);
    const stray = (
      await cashier()
        .post('/approvals', {
          kind: 'void',
          locationId: w.locationA,
          subjectKind: 'order',
          subjectId: sale.id,
          payload: { permission: 'orders.void', orderId: sale.id },
        })
        .expect(201)
    ).body.id as string;
    await cashier()
      .post(`/approvals/${stray}/approve`, {
        factor: { kind: 'pin', userId: w.manager.id, pin: w.managerPin },
      })
      .expect(200);
    const mismatch = await cashier()
      .post(`/orders/${third.id}/void`, { reason: 'x', approvalId: stray }, ifMatch(thirdPlaced))
      .expect(409);
    expect(mismatch.body.error.code).toBe('APPROVAL_PAYLOAD_MISMATCH');
    expect((await owner().get_(third.id)).status).toBe('open');
  });

  it('discount limits: within the cashier’s 10 % applies; over it needs an approval from someone whose own limit covers it', async () => {
    const order = await cashier().create({ lines: [line('Boots', '10000')] });
    const ok = (
      await cashier()
        .post(
          `/orders/${order.id}/discounts`,
          { description: 'Loyalty', percent: '5' },
          ifMatch(order),
        )
        .expect(200)
    ).body as OrderDto;
    expect(ok).toMatchObject({ discountMinor: '500', totalMinor: '9500', version: 2 });
    expect(ok.discounts[0]).toMatchObject({
      kind: 'manual',
      percent: '5',
      amountMinor: '500',
      appliedBy: w.cashier.id,
    });

    const fresh = await cashier().create({ lines: [line('Boots', '10000')] });
    const over = await cashier()
      .post(
        `/orders/${fresh.id}/discounts`,
        { description: 'Mate rates', percent: '25' },
        ifMatch(fresh),
      )
      .expect(409);
    expect(over.body.error.code).toBe('LIMIT_EXCEEDED');
    expect(over.body.error.details).toMatchObject({
      key: 'orders.discount.max_percent',
      attribute: 25,
    });
    // an amount discount is judged by the percent it amounts to: $20.00 of $100.00 = 20 %
    await cashier()
      .post(
        `/orders/${fresh.id}/discounts`,
        { description: 'Gift', amountMinor: '2000' },
        ifMatch(fresh),
      )
      .expect(409);
    await cashier()
      .post(
        `/orders/${fresh.id}/discounts`,
        { description: 'Gift', amountMinor: '1000' },
        ifMatch(fresh),
      )
      .expect(200);

    const target = await cashier().create({ lines: [line('Boots', '10000')] });
    const payload = {
      permission: 'orders.discount.apply',
      attributes: { 'orders.discount.max_percent': 25 },
      orderId: target.id,
    };
    const approval = (
      await cashier()
        .post('/approvals', {
          kind: 'discount_over_limit',
          locationId: w.locationA,
          subjectKind: 'order',
          subjectId: target.id,
          payload,
        })
        .expect(201)
    ).body.id as string;
    // the shift supervisor's own limit is 15 %: cannot approve 25 %
    const low = await cashier()
      .post(`/approvals/${approval}/approve`, {
        factor: { kind: 'pin', userId: w.supervisor.id, pin: w.supervisorPin },
      })
      .expect(403);
    expect(low.body.error.code).toBe('APPROVER_NOT_PERMITTED');
    await cashier()
      .post(`/approvals/${approval}/approve`, {
        factor: { kind: 'pin', userId: w.manager.id, pin: w.managerPin },
      })
      .expect(200);
    // a different discount than the one approved is refused…
    const deeper = await cashier()
      .post(
        `/orders/${target.id}/discounts`,
        { description: 'x', percent: '30', approvalId: approval },
        ifMatch(target),
      )
      .expect(409);
    expect(deeper.body.error.code).toBe('APPROVAL_PAYLOAD_MISMATCH'); // the approval was for 25 %, not 30 %
    const applied = (
      await cashier()
        .post(
          `/orders/${target.id}/discounts`,
          { description: 'Mate rates', percent: '25', approvalId: approval },
          ifMatch(target),
        )
        .expect(200)
    ).body as OrderDto;
    expect(applied).toMatchObject({ discountMinor: '2500', totalMinor: '7500' });
    expect(applied.discounts[0]).toMatchObject({ approvalId: approval, appliedBy: w.cashier.id });
    const events = (await cashier().get(`/orders/${target.id}/events`).expect(200)).body as Array<{
      kind: string;
      approvalId: string | null;
    }>;
    expect(events.find((e) => e.kind === 'discount_applied')!.approvalId).toBe(approval);
    expect(
      (await auditActions(w, target.id)).find((a) => a.action === 'orders.order.discount_applied'),
    ).toMatchObject({ approval_id: approval, on_behalf_of: w.manager.id });
    // single use
    const again = await cashier().create({ lines: [line('Boots', '10000')] });
    await cashier()
      .post(
        `/orders/${again.id}/discounts`,
        { description: 'x', percent: '25', approvalId: approval },
        ifMatch(again),
      )
      .expect(409);
    // remove it again
    const removed = (
      await cashier()
        .delete(`/orders/${target.id}/discounts/${applied.discounts[0]!.id}`, ifMatch(applied))
        .expect(200)
    ).body as OrderDto;
    expect(removed).toMatchObject({ discountMinor: '0', totalMinor: '10000' });
  });

  it('price override needs orders.price.override or an approval, and a reason', async () => {
    const order = await cashier().create();
    await cashier()
      .post(
        `/orders/${order.id}/lines`,
        line('Mug', '1000', '1', { unitPriceMinor: '800', priceOverrideReason: 'chipped' }),
      )
      .expect(403);
    await manager()
      .post(`/orders/${order.id}/lines`, line('Mug', '1000', '1', { unitPriceMinor: '800' }))
      .expect(422); // reason missing
    const ok = (
      await manager()
        .post(
          `/orders/${order.id}/lines`,
          line('Mug', '1000', '1', { unitPriceMinor: '800', priceOverrideReason: 'chipped' }),
        )
        .expect(200)
    ).body as OrderDto;
    expect(ok.lines[0]).toMatchObject({
      listPriceMinor: '1000',
      unitPriceMinor: '800',
      priceOverrideReason: 'chipped',
      totalMinor: '800',
    });
    // the cashier with an approval bound to this exact override
    const payload = {
      permission: 'orders.price.override',
      orderId: order.id,
      variantId: null,
      unitPriceMinor: '700',
    };
    const approval = (
      await cashier()
        .post('/approvals', {
          kind: 'price_override',
          locationId: w.locationA,
          subjectKind: 'order',
          subjectId: order.id,
          payload,
        })
        .expect(201)
    ).body.id as string;
    await cashier()
      .post(`/approvals/${approval}/approve`, {
        factor: { kind: 'pin', userId: w.manager.id, pin: w.managerPin },
      })
      .expect(200);
    const viaApproval = (
      await cashier()
        .post(
          `/orders/${order.id}/lines`,
          line('Mug', '1000', '1', {
            unitPriceMinor: '700',
            priceOverrideReason: 'chipped',
            priceOverrideApprovalId: approval,
          }),
        )
        .expect(200)
    ).body as OrderDto;
    expect(viaApproval.lines[1]).toMatchObject({
      unitPriceMinor: '700',
      priceOverrideApprovalId: approval,
    });
  });

  it('charges, notes and order details', async () => {
    const order = await cashier().create({ kind: 'dine_in', lines: [line('Pasta', '2000')] });
    const withCharge = (
      await cashier()
        .post(
          `/orders/${order.id}/charges`,
          { kind: 'service_charge', description: '10 % service', percent: '10', taxable: false },
          ifMatch(order),
        )
        .expect(200)
    ).body as OrderDto;
    expect(withCharge).toMatchObject({ chargesMinor: '200', totalMinor: '2200' });
    const more = (
      await cashier().post(`/orders/${order.id}/lines`, line('Salad', '1000')).expect(200)
    ).body as OrderDto;
    expect(more).toMatchObject({ chargesMinor: '300', totalMinor: '3300' }); // the percent charge follows the check
    const patched = (
      await cashier()
        .patch(`/orders/${order.id}`, { notes: 'birthday', guestCount: 4 }, ifMatch(more))
        .expect(200)
    ).body as OrderDto;
    expect(patched).toMatchObject({ notes: 'birthday', guestCount: 4 });
    await cashier().patch(`/orders/${order.id}`, {}, ifMatch(patched)).expect(422);
    const gone = (
      await cashier()
        .delete(`/orders/${order.id}/charges/${withCharge.charges[0]!.id}`, ifMatch(patched))
        .expect(200)
    ).body as OrderDto;
    expect(gone).toMatchObject({ chargesMinor: '0', totalMinor: '3000' });
  });

  it('list: newest first with a cursor, filters by status and kind', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
      ids.push(
        (await cashier().create({ kind: 'takeaway', clientCreatedAt: '2026-08-01T05:00:00Z' })).id,
      );
    const page1 = (
      await cashier().get(`/orders?locationId=${w.locationA}&kind=takeaway&limit=2`).expect(200)
    ).body;
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBe(page1.items[1].id);
    const page2 = (
      await cashier()
        .get(`/orders?locationId=${w.locationA}&kind=takeaway&limit=2&cursor=${page1.nextCursor}`)
        .expect(200)
    ).body;
    const seen = [...page1.items, ...page2.items].map((o: { id: string }) => o.id);
    expect(seen.slice(0, 3)).toEqual([...ids].reverse());
    expect(page1.items[0]).toMatchObject({ kind: 'takeaway', status: 'draft', totalMinor: '0' });
    const none = (
      await cashier()
        .get(`/orders?locationId=${w.locationA}&status=voided&kind=takeaway`)
        .expect(200)
    ).body;
    expect(none.items).toEqual([]);
    await cashier().get(`/orders?locationId=${w.locationA}&limit=500`).expect(422);
  });

  it('order_events are append-only and every command left an audit entry', async () => {
    const order = await cashier().create({ lines: [line()] });
    await cashier().place(order);
    const events = await w.db.admin.query<{ id: string }>(
      'SELECT id FROM orders.order_events WHERE order_id = $1',
      [order.id],
    );
    expect(events.rowCount).toBeGreaterThanOrEqual(3);
    await expect(
      w.db.admin.query("UPDATE orders.order_events SET kind = 'tampered' WHERE order_id = $1", [
        order.id,
      ]),
    ).rejects.toThrow();
    await expect(
      w.db.admin.query('DELETE FROM orders.order_events WHERE order_id = $1', [order.id]),
    ).rejects.toThrow();
    expect((await auditActions(w, order.id)).map((a) => a.action)).toEqual([
      'orders.order.created',
      'orders.order.placed',
    ]);
  });
});
