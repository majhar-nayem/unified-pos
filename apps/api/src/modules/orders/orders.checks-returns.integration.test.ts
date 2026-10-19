import type { OrderDto } from '@pos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { auditActions, client, ifMatch, line, outbox, port } from './testing/helpers.js';
import { buildOrdersWorld, type OrdersWorld } from './testing/orders-world.js';

describe('orders: checks, shared items, returns, OrderPort', () => {
  let w: OrdersWorld;
  beforeAll(async () => {
    w = await buildOrdersWorld();
  }, 240_000);
  afterAll(async () => {
    await w?.close();
  });

  const cashier = () => client(w, w.cashier.token);
  const supervisor = () => client(w, w.supervisor.token);
  const manager = () => client(w, w.manager.token);
  const owner = () => client(w, w.ownerToken);
  const sum = (xs: string[]) => xs.reduce((a, b) => a + BigInt(b), 0n);

  const bill = async () =>
    owner().create({
      kind: 'dine_in',
      lines: [
        line('Steak', '3000', '1', { seatNumber: 1 }),
        line('Salad', '1500', '1', { seatNumber: 2 }),
        line('Wine', '2000', '1', { seatNumber: 2 }),
      ],
    });

  describe('split and merge checks', () => {
    it('split by seat, by lines and merge; every step keeps the order total and the per-check totals add up', async () => {
      const order = await bill();
      const bySeat = (
        await cashier()
          .post(
            `/orders/${order.id}/checks/split`,
            { mode: 'seats', fromCheckId: order.checks[0]!.id, seatNumbers: [2], label: 'Seat 2' },
            ifMatch(order),
          )
          .expect(200)
      ).body as OrderDto;
      expect(bySeat.checks.map((c) => [c.number, c.label, c.totalMinor])).toEqual([
        [1, null, '3000'],
        [2, 'Seat 2', '3500'],
      ]);
      expect(bySeat.totalMinor).toBe('6500');
      expect(
        bySeat.lines.filter((l) => l.checkId === bySeat.checks[1]!.id).map((l) => l.item.name),
      ).toEqual(['Salad', 'Wine']);

      const wine = bySeat.lines.find((l) => l.item.name === 'Wine')!;
      const byLine = (
        await cashier()
          .post(
            `/orders/${order.id}/checks/split`,
            { mode: 'lines', fromCheckId: bySeat.checks[1]!.id, lineIds: [wine.id], label: 'Wine' },
            ifMatch(bySeat),
          )
          .expect(200)
      ).body as OrderDto;
      expect(byLine.checks.map((c) => c.totalMinor)).toEqual(['3000', '1500', '2000']);

      const merged = (
        await cashier()
          .post(
            `/orders/${order.id}/checks/merge`,
            { sourceCheckId: byLine.checks[2]!.id, targetCheckId: byLine.checks[1]!.id },
            ifMatch(byLine),
          )
          .expect(200)
      ).body as OrderDto;
      expect(merged.checks.map((c) => [c.status, c.totalMinor])).toEqual([
        ['open', '3000'],
        ['open', '3500'],
        ['voided', '0'],
      ]);
      expect(merged.totalMinor).toBe('6500');
      expect(sum(merged.checks.map((c) => c.totalMinor))).toBe(BigInt(merged.totalMinor));
      expect(sum(merged.checks.map((c) => c.taxMinor))).toBe(BigInt(merged.taxMinor));

      const events = (await cashier().get(`/orders/${order.id}/events`).expect(200)).body as Array<{
        kind: string;
      }>;
      expect(events.map((e) => e.kind).filter((k) => k.startsWith('check_'))).toEqual([
        'check_split',
        'check_split',
        'check_merged',
      ]);
      // bad requests
      await cashier()
        .post(
          `/orders/${order.id}/checks/split`,
          {
            mode: 'lines',
            fromCheckId: merged.checks[0]!.id,
            lineIds: ['00000000-0000-4000-8000-000000000000'],
          },
          ifMatch(merged),
        )
        .expect(404);
      await cashier()
        .post(
          `/orders/${order.id}/checks/merge`,
          { sourceCheckId: merged.checks[0]!.id, targetCheckId: merged.checks[0]!.id },
          ifMatch(merged),
        )
        .expect(422);
    });

    it('a check that took money is frozen; new lines land on the open check; paying every check completes the order', async () => {
      const order = await bill();
      const split = (
        await cashier()
          .post(
            `/orders/${order.id}/checks/split`,
            { mode: 'seats', fromCheckId: order.checks[0]!.id, seatNumbers: [2] },
            ifMatch(order),
          )
          .expect(200)
      ).body as OrderDto;
      const placed = await cashier().place(split);
      const [c1, c2] = placed.checks;
      await port(w).applyPayment({
        orderId: order.id,
        checkId: c2!.id,
        amountMinor: 3500n,
        paymentRef: 'seat2-card',
      });
      const afterPay = await owner().get_(order.id);
      expect(afterPay).toMatchObject({
        paymentStatus: 'partially_paid',
        paidMinor: '3500',
        status: 'open',
      });
      expect(afterPay.checks[1]).toMatchObject({ status: 'closed', paidMinor: '3500' });
      // frozen: its lines, discounts and merges are refused
      const paidLine = afterPay.lines.find((l) => l.checkId === c2!.id)!;
      await cashier()
        .patch(`/orders/${order.id}/lines/${paidLine.id}`, { quantity: '2' }, ifMatch(afterPay))
        .expect(409);
      await cashier()
        .post(
          `/orders/${order.id}/checks/merge`,
          { sourceCheckId: c2!.id, targetCheckId: c1!.id },
          ifMatch(afterPay),
        )
        .expect(409);
      await cashier()
        .post(
          `/orders/${order.id}/discounts`,
          { description: 'x', percent: '5' },
          ifMatch(afterPay),
        )
        .expect(409); // order-level, money already taken
      // a new round goes to the open check
      const more = (
        await cashier()
          .post(`/orders/${order.id}/lines`, line('Coffee', '400', '1', { seatNumber: 1 }))
          .expect(200)
      ).body as OrderDto;
      expect(more.lines.at(-1)!.checkId).toBe(c1!.id);
      expect(more.checks[0]!.totalMinor).toBe('3400');
      // the order is not complete until every check is settled
      await expect(port(w).markPaid({ orderId: order.id })).rejects.toMatchObject({
        code: 'ORDER_NOT_FULLY_PAID',
      });
      await port(w).applyPayment({
        orderId: order.id,
        checkId: c1!.id,
        amountMinor: 3400n,
        paymentRef: 'seat1-cash',
      });
      await port(w).markPaid({ orderId: order.id });
      expect(await owner().get_(order.id)).toMatchObject({
        status: 'completed',
        paymentStatus: 'paid',
        paidMinor: '6900',
        totalMinor: '6900',
      });
    });

    it('a shared item is split into fractional portions across checks and the portions pay out to exactly the original price', async () => {
      const order = await owner().create({ kind: 'dine_in', lines: [line('Pizza', '2599', '1')] });
      const shared = (
        await owner()
          .post(
            `/orders/${order.id}/checks/split`,
            { mode: 'share', lineId: order.lines[0]!.id, parts: 3 },
            ifMatch(order),
          )
          .expect(200)
      ).body as OrderDto;
      expect(shared.lines.map((l) => l.quantity)).toEqual(['0.3334', '0.3333', '0.3333']);
      expect(shared.checks).toHaveLength(3);
      expect(sum(shared.lines.map((l) => l.totalMinor))).toBe(2599n);
      expect(sum(shared.checks.map((c) => c.totalMinor))).toBe(2599n);
      expect(shared.totalMinor).toBe('2599');
      expect(
        shared.lines.every(
          (l) => l.metadata && !Object.keys(l.metadata).some((k) => k.startsWith('_')),
        ),
      ).toBe(true); // bookkeeping stays internal
      // portions have a fixed amount
      await owner()
        .patch(
          `/orders/${order.id}/lines/${shared.lines[1]!.id}`,
          { quantity: '1' },
          ifMatch(shared),
        )
        .expect(409);
      const placed = await owner().place(shared);
      await port(w).settle(placed);
      const done = await owner().get_(order.id);
      expect(done).toMatchObject({ status: 'completed', paidMinor: '2599' });
      // explicit shares, a named new check for each guest
      const second = await owner().create({
        kind: 'dine_in',
        lines: [line('Platter', '2000', '2')],
      });
      const explicit = (
        await owner()
          .post(
            `/orders/${second.id}/checks/split`,
            {
              mode: 'share',
              lineId: second.lines[0]!.id,
              shares: [{ quantity: '0.5' }, { quantity: '1.5', label: 'Bob' }],
            },
            ifMatch(second),
          )
          .expect(200)
      ).body as OrderDto;
      expect(explicit.checks.map((c) => [c.label, c.totalMinor])).toEqual([
        [null, '1000'],
        ['Bob', '3000'],
      ]);
      await owner()
        .post(
          `/orders/${second.id}/checks/split`,
          {
            mode: 'share',
            lineId: explicit.lines[0]!.id,
            shares: [{ quantity: '0.4' }, { quantity: '0.4' }],
          },
          ifMatch(explicit),
        )
        .expect(422);
    });
  });

  describe('returns and exchanges', () => {
    /** 3 × $4.00 with a $2.00 line discount: $10.00 paid; completed. */
    const completedSale = async () => {
      const draft = await owner().create({ lines: [line('Widget', '400', '3')] });
      const discounted = (
        await owner()
          .post(
            `/orders/${draft.id}/discounts`,
            { lineId: draft.lines[0]!.id, amountMinor: '200', description: 'Clearance' },
            ifMatch(draft),
          )
          .expect(200)
      ).body as OrderDto;
      const placed = await owner().place(discounted);
      await port(w).settle(placed);
      return owner().get_(draft.id);
    };

    it('partial returns refund exactly what was paid; the source is never edited, only its returned quantity and refund state move', async () => {
      const sale = await completedSale();
      expect(sale).toMatchObject({ status: 'completed', totalMinor: '1000' });
      const widget = sale.lines[0]!;
      await cashier()
        .post(`/orders/${sale.id}/returns`, { lines: [{ sourceLineId: widget.id, quantity: '1' }] })
        .expect(403); // a cashier has no orders.refund.create

      const draft = (
        await manager()
          .post(`/orders/${sale.id}/returns`, {
            lines: [{ sourceLineId: widget.id, quantity: '1', reason: 'faulty' }],
            reason: 'faulty',
          })
          .expect(201)
      ).body as OrderDto;
      expect(draft).toMatchObject({
        kind: 'return',
        status: 'draft',
        sourceOrderId: sale.id,
        fulfillmentStatus: 'not_applicable',
        totalMinor: '-333',
        taxMinor: '-30',
        version: 1,
      });
      expect(draft.lines[0]).toMatchObject({
        returnOfLineId: widget.id,
        quantity: '1.0000',
        totalMinor: '-333',
      });
      // nothing changed on the original yet
      expect((await owner().get_(sale.id)).lines[0]!.returnedQuantity).toBe('0.0000');

      const placed = await manager().place(draft);
      expect(placed).toMatchObject({ status: 'open', orderNumber: expect.any(Number) });
      expect((await owner().get_(sale.id)).lines[0]).toMatchObject({
        returnedQuantity: '1.0000',
        status: 'active',
        totalMinor: '1000',
      });
      // money goes back as a negative payment; completing the return refunds the source
      await port(w).applyPayment({
        orderId: draft.id,
        amountMinor: -333n,
        paymentRef: 'refund-1',
        method: 'cash',
      });
      await port(w).markPaid({ orderId: draft.id });
      expect(await owner().get_(draft.id)).toMatchObject({
        status: 'completed',
        paymentStatus: 'paid',
        paidMinor: '-333',
        totalMinor: '-333',
      });
      expect(await owner().get_(sale.id)).toMatchObject({
        status: 'completed',
        totalMinor: '1000',
        paidMinor: '1000',
        refundedMinor: '333',
        paymentStatus: 'partially_refunded',
      });

      // the rest: the running total makes the parts add up to the original $10.00
      const rest = (
        await manager()
          .post(`/orders/${sale.id}/returns`, {
            lines: [{ sourceLineId: widget.id, quantity: '2' }],
          })
          .expect(201)
      ).body as OrderDto;
      expect(rest.totalMinor).toBe('-667');
      await manager().place(rest);
      await port(w).applyPayment({ orderId: rest.id, amountMinor: -667n, paymentRef: 'refund-2' });
      await port(w).markPaid({ orderId: rest.id });
      const source = await owner().get_(sale.id);
      expect(source).toMatchObject({
        refundedMinor: '1000',
        paymentStatus: 'refunded',
        status: 'completed',
      });
      expect(source.lines[0]).toMatchObject({ returnedQuantity: '3.0000', status: 'returned' });
      await manager()
        .post(`/orders/${sale.id}/returns`, { lines: [{ sourceLineId: widget.id, quantity: '1' }] })
        .expect(409);
      // the source is history now: it cannot be voided out from under its returns
      const voidTry = await manager()
        .post(`/orders/${sale.id}/void`, { reason: 'x' }, ifMatch(source))
        .expect(409);
      expect(voidTry.body.error.code).toBe('ORDER_HAS_RETURNS');

      const events = (await owner().get(`/orders/${sale.id}/events`).expect(200)).body as Array<{
        kind: string;
      }>;
      expect(events.map((e) => e.kind)).toEqual(
        expect.arrayContaining(['returned', 'refund_applied']),
      );
      expect(await outbox(w, draft.id)).toEqual([
        'order.placed',
        'order.returned',
        'order.completed',
      ]);
      expect((await auditActions(w, draft.id)).map((a) => a.action)).toEqual(
        expect.arrayContaining([
          'orders.order.return_created',
          'orders.order.placed',
          'orders.order.payment_applied',
          'orders.order.completed',
        ]),
      );
    });

    it('returns need a completed source, a returnable quantity, and a draft return can be cancelled; a placed one gives its units back', async () => {
      const open = await owner().create({ lines: [line('A', '1000')] });
      const openPlaced = await owner().place(open);
      const early = await manager()
        .post(`/orders/${open.id}/returns`, {
          lines: [{ sourceLineId: openPlaced.lines[0]!.id, quantity: '1' }],
        })
        .expect(409);
      expect(early.body.error.code).toBe('SOURCE_NOT_COMPLETED');

      const sale = await completedSale();
      const widget = sale.lines[0]!;
      await manager()
        .post(`/orders/${sale.id}/returns`, { lines: [{ sourceLineId: widget.id, quantity: '4' }] })
        .expect(409);
      await manager()
        .post(`/orders/${sale.id}/returns`, { lines: [{ sourceLineId: widget.id, quantity: '0' }] })
        .expect(422);
      await manager().post(`/orders/${sale.id}/returns`, { lines: [] }).expect(422);
      await manager()
        .post(`/orders/${sale.id}/returns`, {
          lines: [
            { sourceLineId: widget.id, quantity: '1' },
            { sourceLineId: widget.id, quantity: '1' },
          ],
        })
        .expect(422);

      const draft = (
        await manager()
          .post(`/orders/${sale.id}/returns`, {
            lines: [{ sourceLineId: widget.id, quantity: '3' }],
          })
          .expect(201)
      ).body as OrderDto;
      const discarded = (
        await manager()
          .post(`/orders/${draft.id}/void`, { reason: 'changed mind' }, ifMatch(draft))
          .expect(200)
      ).body as OrderDto;
      expect(discarded.status).toBe('cancelled');
      expect((await owner().get_(sale.id)).lines[0]!.returnedQuantity).toBe('0.0000');

      const again = (
        await manager()
          .post(`/orders/${sale.id}/returns`, {
            lines: [{ sourceLineId: widget.id, quantity: '3' }],
          })
          .expect(201)
      ).body as OrderDto;
      const placed = await manager().place(again);
      expect((await owner().get_(sale.id)).lines[0]).toMatchObject({
        returnedQuantity: '3.0000',
        status: 'returned',
      });
      await manager()
        .post(`/orders/${again.id}/void`, { reason: 'customer left' }, ifMatch(placed))
        .expect(200);
      expect((await owner().get_(sale.id)).lines[0]).toMatchObject({
        returnedQuantity: '0.0000',
        status: 'active',
      });
      expect(await outbox(w, again.id)).toEqual(['order.placed', 'order.returned', 'order.voided']);
    });

    it('a refund over the caller’s limit needs an approval from someone whose own limit covers it', async () => {
      const draft = await owner().create({ lines: [line('Jacket', '30000')] });
      const placed = await owner().place(draft);
      await port(w).settle(placed);
      const sale = await owner().get_(draft.id);
      const ret = (
        await supervisor()
          .post(`/orders/${sale.id}/returns`, {
            lines: [{ sourceLineId: sale.lines[0]!.id, quantity: '1' }],
          })
          .expect(201)
      ).body as OrderDto;
      expect(ret.totalMinor).toBe('-30000');
      // the shift supervisor may refund up to $200.00
      const over = await supervisor().post(`/orders/${ret.id}/place`, {}, ifMatch(ret)).expect(409);
      expect(over.body.error.code).toBe('LIMIT_EXCEEDED');
      expect(over.body.error.details).toMatchObject({
        key: 'orders.refund.max_minor',
        attribute: 30000,
      });
      const payload = {
        permission: 'orders.refund.create',
        attributes: { 'orders.refund.max_minor': 30000 },
        orderId: ret.id,
      };
      // the cashier files the request (shift supervisors cannot); it names this return and this amount
      const approval = (
        await cashier()
          .post('/approvals', {
            kind: 'refund_over_limit',
            locationId: w.locationA,
            subjectKind: 'order',
            subjectId: ret.id,
            payload,
          })
          .expect(201)
      ).body.id as string;
      // a supervisor's own limit ($200.00) does not stretch to $300.00, so their PIN cannot approve it
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
        .expect(200); // manager: $500.00
      const done = (
        await supervisor()
          .post(`/orders/${ret.id}/place`, { approvalId: approval }, ifMatch(ret))
          .expect(200)
      ).body as OrderDto;
      expect(done.status).toBe('open');
      expect(
        (await auditActions(w, ret.id)).find((a) => a.action === 'orders.order.placed'),
      ).toMatchObject({ approval_id: approval, on_behalf_of: w.manager.id });
    });

    it('an exchange returns lines and sells new ones in one order; the customer pays the difference', async () => {
      const sale = await completedSale();
      const ex = (
        await manager()
          .post(`/orders/${sale.id}/returns`, {
            kind: 'exchange',
            lines: [{ sourceLineId: sale.lines[0]!.id, quantity: '1' }],
          })
          .expect(201)
      ).body as OrderDto;
      expect(ex).toMatchObject({ kind: 'exchange', totalMinor: '-333' });
      const withNew = (
        await manager().post(`/orders/${ex.id}/lines`, line('Premium widget', '2000')).expect(200)
      ).body as OrderDto;
      expect(withNew.totalMinor).toBe('1667');
      const placed = await manager().place(withNew);
      expect((await owner().get_(sale.id)).lines[0]!.returnedQuantity).toBe('1.0000');
      await port(w).applyPayment({ orderId: ex.id, amountMinor: 1667n, paymentRef: 'diff-1' });
      await port(w).markPaid({ orderId: ex.id });
      expect(await owner().get_(ex.id)).toMatchObject({
        status: 'completed',
        paymentStatus: 'paid',
        totalMinor: '1667',
      });
      expect(await owner().get_(sale.id)).toMatchObject({
        refundedMinor: '333',
        paymentStatus: 'partially_refunded',
      });
      expect(await outbox(w, ex.id)).toEqual(['order.placed', 'order.returned', 'order.completed']);
      expect(placed.kind).toBe('exchange');
    });
  });

  describe('OrderPort (what payments calls)', () => {
    const placedSale = async (price = '1000') => {
      const d = await owner().create({ lines: [line('Item', price)] });
      return owner().place(d);
    };

    it('applyPayment is idempotent per paymentRef, also when the same capture arrives in parallel', async () => {
      const order = await placedSale('1000');
      const p = port(w);
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          p.applyPayment({ orderId: order.id, amountMinor: 400n, paymentRef: 'intent-1' }),
        ),
      );
      expect(results.every((r) => r.paidMinor === 400n)).toBe(true);
      const after = await owner().get_(order.id);
      expect(after).toMatchObject({ paidMinor: '400', paymentStatus: 'partially_paid' });
      const applied = await w.db.admin.query(
        "SELECT 1 FROM orders.order_events WHERE order_id = $1 AND kind = 'payment_applied'",
        [order.id],
      );
      expect(applied.rowCount).toBe(1);
      expect((await p.totals(order.id)).dueMinor).toBe(600n);
    });

    it('parallel distinct payments serialise on the order; the one that would overpay is refused', async () => {
      const order = await placedSale('1000');
      const p = port(w);
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          p.applyPayment({ orderId: order.id, amountMinor: 100n, paymentRef: `part-${i}` }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(refused).toHaveLength(2);
      expect(
        refused.every((r) =>
          ['OVERPAYMENT', 'NOTHING_DUE'].includes((r.reason as { code?: string }).code ?? ''),
        ),
      ).toBe(true);
      expect(await owner().get_(order.id)).toMatchObject({
        paidMinor: '1000',
        paymentStatus: 'paid',
      });
    });

    it('markPaid needs every check settled, completes once, emits order.completed once, and fulfils a retail sale', async () => {
      const order = await placedSale('1250');
      await expect(port(w).markPaid({ orderId: order.id })).rejects.toMatchObject({
        code: 'ORDER_NOT_FULLY_PAID',
      });
      await port(w).applyPayment({ orderId: order.id, amountMinor: 1250n, paymentRef: 'full' });
      const first = await port(w).markPaid({ orderId: order.id, paymentRef: 'full' });
      const second = await port(w).markPaid({ orderId: order.id, paymentRef: 'full' });
      expect(first.status).toBe('completed');
      expect(second.status).toBe('completed');
      expect(await outbox(w, order.id)).toEqual(['order.placed', 'order.completed']);
      expect(await owner().get_(order.id)).toMatchObject({
        status: 'completed',
        paymentStatus: 'paid',
        fulfillmentStatus: 'fulfilled',
      });
      await expect(
        port(w).applyPayment({ orderId: order.id, amountMinor: 1n, paymentRef: 'late' }),
      ).rejects.toMatchObject({ code: 'ORDER_NOT_OPEN' });
    });

    it('tip and cash rounding: the check total follows, the payment covers them', async () => {
      const order = await placedSale('1883');
      await port(w).applyPayment({
        orderId: order.id,
        amountMinor: 1885n + 200n,
        tipMinor: 200n,
        roundingMinor: 2n,
        paymentRef: 'cash-1',
        method: 'cash',
      });
      const done = await owner().get_(order.id);
      expect(done).toMatchObject({
        tipMinor: '200',
        roundingMinor: '2',
        totalMinor: '2085',
        paidMinor: '2085',
        paymentStatus: 'paid',
      });
      await port(w).markPaid({ orderId: order.id });
    });

    it('refunds on a completed sale (idempotent per paymentRef) and the offline-decline reopen', async () => {
      const order = await placedSale('1000');
      await port(w).settle(order, 'sale');
      const p = port(w);
      await p.applyRefund({
        orderId: order.id,
        amountMinor: 300n,
        paymentRef: 'rf-1',
        reason: 'faulty',
      });
      await p.applyRefund({
        orderId: order.id,
        amountMinor: 300n,
        paymentRef: 'rf-1',
        reason: 'faulty',
      });
      expect(await owner().get_(order.id)).toMatchObject({
        refundedMinor: '300',
        paymentStatus: 'partially_refunded',
      });
      await expect(
        p.applyRefund({ orderId: order.id, amountMinor: 800n, paymentRef: 'rf-2' }),
      ).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_PAID' });
      await p.applyRefund({ orderId: order.id, amountMinor: 700n, paymentRef: 'rf-3' });
      expect(await owner().get_(order.id)).toMatchObject({
        refundedMinor: '1000',
        paymentStatus: 'refunded',
      });

      const offline = await placedSale('2000');
      await p.settle(offline, 'off');
      const reopened = await p.reopenOffline({
        orderId: offline.id,
        reversedMinor: 2000n,
        reason: 'offline_payment_declined',
        paymentRef: 'declined-1',
      });
      expect(reopened).toMatchObject({ status: 'open', paymentStatus: 'unpaid', paidMinor: 0n });
      expect(await owner().get_(offline.id)).toMatchObject({
        status: 'open',
        reopenedReason: 'offline_payment_declined',
        completedAt: null,
      });
      await p.applyPayment({ orderId: offline.id, amountMinor: 2000n, paymentRef: 'retry-1' });
      await p.markPaid({ orderId: offline.id });
      expect((await owner().get_(offline.id)).status).toBe('completed');
      const kinds = (await owner().get(`/orders/${offline.id}/events`).expect(200)).body as Array<{
        kind: string;
      }>;
      expect(kinds.map((e) => e.kind)).toContain('reopened_offline_decline');
    });

    it('a payment rolls back with the caller’s transaction (no half-applied money)', async () => {
      const order = await placedSale('1000');
      const p = port(w);
      await expect(
        p.run(async (tx, svc) => {
          await svc.applyPayment(tx, {
            orderId: order.id,
            amountMinor: 1000n,
            paymentRef: 'will-roll-back',
          });
          throw new Error('payment provider write failed');
        }),
      ).rejects.toThrow('provider write failed');
      expect(await owner().get_(order.id)).toMatchObject({
        paidMinor: '0',
        paymentStatus: 'unpaid',
      });
      const events = await w.db.admin.query(
        "SELECT 1 FROM orders.order_events WHERE order_id = $1 AND kind = 'payment_applied'",
        [order.id],
      );
      expect(events.rowCount).toBe(0);
    });
  });
});
