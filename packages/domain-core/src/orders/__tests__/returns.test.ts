import { describe, expect, it } from 'vitest';

import { addLine } from '../lines.js';
import { applyDiscount } from '../discounts.js';
import { place, voidOrder } from '../lifecycle.js';
import { applyPayment, markPaid } from '../payments.js';
import {
  applyReturnRefundToSource,
  buildReturnOrder,
  placeReturn,
  releaseReturn,
  returnRefundMinor,
} from '../returns.js';
import { parseQuantity } from '../quantity.js';
import { OrderRuleError, type OrderState } from '../types.js';
import { add, assertDbInvariants, draft, makeCtx, snapshot } from './helpers.js';

const rule = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(OrderRuleError);
    expect((e as OrderRuleError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
};

/** 3 × $4.00 with a $2.00 line discount: the customer paid $10.00 net for three units. */
function source(
  ctx = makeCtx(),
  pricingMode: 'tax_inclusive' | 'tax_exclusive' = 'tax_inclusive',
): OrderState {
  let o = draft(ctx, { pricingMode });
  o = add(o, ctx, 'Widget', 400n, '3').state;
  o = applyDiscount(
    o,
    { lineId: o.lines[0]!.id, amountMinor: 200n, description: 'Clearance', appliedBy: 'u' },
    ctx,
  ).state;
  o = place(o, { orderNumber: 1 }, ctx).state;
  o = applyPayment(o, { amountMinor: o.totalMinor, paymentRef: 'sale-1' }, ctx).state;
  return markPaid(o, ctx).state;
}

const build = (
  src: OrderState,
  ctx: ReturnType<typeof makeCtx>,
  qty: string,
  kind: 'return' | 'exchange' = 'return',
) =>
  buildReturnOrder(
    src,
    {
      kind,
      lines: [{ sourceLineId: src.lines[0]!.id, quantity: qty, reason: 'faulty' }],
      businessDate: '2026-10-19',
    },
    ctx,
  );

describe('return refund arithmetic', () => {
  it('partial returns add up to exactly what was paid', () => {
    const ctx = makeCtx();
    const src = source(ctx);
    expect(src.totalMinor).toBe(1000n);
    const line = src.lines[0]!;
    const one = parseQuantity('1');
    const parts = [0n, 1n, 2n].map((k) => returnRefundMinor(src, line, k * one, one));
    expect(parts).toEqual([333n, 334n, 333n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(1000n);
    expect(returnRefundMinor(src, line, 0n, parseQuantity('3'))).toBe(1000n);
  });
});

describe('buildReturnOrder', () => {
  it('creates a draft return with negative amounts that reference the original line', () => {
    const ctx = makeCtx();
    const src = source(ctx);
    const snapshotBefore = JSON.stringify(src, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    const r = build(src, ctx, '1');
    expect(r.state).toMatchObject({
      kind: 'return',
      status: 'draft',
      sourceOrderId: src.id,
      fulfillmentStatus: 'not_applicable',
      version: 1,
      businessDate: '2026-10-19',
      totalMinor: -333n,
      taxMinor: -30n,
    });
    expect(r.state.lines[0]).toMatchObject({
      returnOfLineId: src.lines[0]!.id,
      quantity: '1.0000',
      totalMinor: -333n,
      grossOverrideMinor: -333n,
    });
    expect(r.state.lines[0]!.metadata).toMatchObject({
      returnReason: 'faulty',
      sourceOrderId: src.id,
    });
    expect(r.events.map((e) => e.kind)).toEqual(['created', 'line_added']);
    assertDbInvariants(r.state);
    // the original is never mutated
    expect(JSON.stringify(src, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(
      snapshotBefore,
    );
  });

  it('exclusive pricing refunds the net and re-extracts the tax', () => {
    const ctx = makeCtx();
    let o = draft(ctx, { pricingMode: 'tax_exclusive' });
    o = add(o, ctx, 'Widget', 1000n).state;
    o = place(o, { orderNumber: 1 }, ctx).state;
    o = markPaid(applyPayment(o, { amountMinor: 1100n, paymentRef: 'p' }, ctx).state, ctx).state;
    const r = build(o, ctx, '1');
    expect(r.state).toMatchObject({ subtotalMinor: -1000n, taxMinor: -100n, totalMinor: -1100n });
    assertDbInvariants(r.state);
  });

  it('refuses what cannot be returned', () => {
    const ctx = makeCtx();
    const src = source(ctx);
    rule(() => build(src, ctx, '4'), 'RETURN_QUANTITY_EXCEEDED');
    rule(() => build(src, ctx, '0'), 'QUANTITY_INVALID');
    rule(
      () => buildReturnOrder(src, { kind: 'return', lines: [], businessDate: '2026-10-19' }, ctx),
      'RETURN_EMPTY',
    );
    rule(
      () =>
        buildReturnOrder(
          src,
          {
            kind: 'return',
            businessDate: '2026-10-19',
            lines: [
              { sourceLineId: src.lines[0]!.id, quantity: '1' },
              { sourceLineId: src.lines[0]!.id, quantity: '1' },
            ],
          },
          ctx,
        ),
      'RETURN_LINE_DUPLICATE',
    );
    rule(
      () =>
        buildReturnOrder(
          src,
          {
            kind: 'return',
            businessDate: '2026-10-19',
            lines: [{ sourceLineId: 'nope', quantity: '1' }],
          },
          ctx,
        ),
      'LINE_NOT_FOUND',
    );
    const notDone = place(add(draft(ctx), ctx, 'A', 100n).state, { orderNumber: 2 }, ctx).state;
    rule(() => build(notDone, ctx, '1'), 'SOURCE_NOT_COMPLETED');
    const ret = build(src, ctx, '1').state;
    rule(() => build({ ...ret, status: 'completed' }, ctx, '1'), 'SOURCE_IS_RETURN');
    const voided = { ...src, lines: src.lines.map((l) => ({ ...l, status: 'voided' as const })) };
    rule(() => build(voided, ctx, '1'), 'SOURCE_LINE_NOT_RETURNABLE');
    const wasReturn = { ...src, lines: src.lines.map((l) => ({ ...l, returnOfLineId: 'x' })) };
    rule(() => build(wasReturn, ctx, '1'), 'SOURCE_LINE_IS_RETURN');
  });
});

describe('placeReturn / releaseReturn', () => {
  it('reserves the quantity on the source in the same step and marks a fully returned line', () => {
    const ctx = makeCtx();
    const src = source(ctx);
    const r1 = placeReturn(build(src, ctx, '1').state, src, { orderNumber: 1 }, ctx);
    expect(r1.state).toMatchObject({ status: 'open', orderNumber: 1 });
    expect(r1.source.lines[0]).toMatchObject({ returnedQuantity: '1.0000', status: 'active' });
    expect(r1.source.version).toBe(src.version + 1);
    expect(r1.sourceEvents[0]).toMatchObject({
      kind: 'returned',
      payload: { returnOrderId: r1.state.id },
    });
    const r2 = placeReturn(build(r1.source, ctx, '2').state, r1.source, { orderNumber: 2 }, ctx);
    expect(r2.source.lines[0]).toMatchObject({ returnedQuantity: '3.0000', status: 'returned' });
    expect(r2.state.totalMinor).toBe(-667n); // 1000 − 333: the running total makes the parts add up
    rule(() => build(r2.source, ctx, '1'), 'RETURN_QUANTITY_EXCEEDED');
  });

  it('two drafts cannot both claim the same units: the second place fails and reprices from the source as it is now', () => {
    const ctx = makeCtx();
    const src = source(ctx);
    const a = build(src, ctx, '2').state;
    const b = build(src, ctx, '2').state;
    const placed = placeReturn(a, src, { orderNumber: 1 }, ctx);
    rule(() => placeReturn(b, placed.source, { orderNumber: 2 }, ctx), 'RETURN_QUANTITY_EXCEEDED');
    const c = build(placed.source, ctx, '1').state;
    expect(c.totalMinor).toBe(-333n);
    expect(placeReturn(c, placed.source, { orderNumber: 3 }, ctx).state.totalMinor).toBe(-333n);
  });

  it('a draft built earlier is repriced at place time', () => {
    const ctx = makeCtx();
    const src = source(ctx);
    const first = build(src, ctx, '1').state;
    const second = build(src, ctx, '1').state; // also priced as the first unit: −333
    const p1 = placeReturn(first, src, { orderNumber: 1 }, ctx);
    const p2 = placeReturn(second, p1.source, { orderNumber: 2 }, ctx);
    expect(p2.state.totalMinor).toBe(-334n); // now the second unit
  });

  it('rejects a return placed against the wrong or unfinished source', () => {
    const ctx = makeCtx();
    const src = source(ctx);
    const other = source(ctx);
    rule(
      () => placeReturn(build(src, ctx, '1').state, other, { orderNumber: 1 }, ctx),
      'SOURCE_MISMATCH',
    );
    rule(() => placeReturn(draft(ctx), src, { orderNumber: 1 }, ctx), 'SOURCE_MISMATCH');
    const placed = placeReturn(build(src, ctx, '1').state, src, { orderNumber: 1 }, ctx);
    rule(
      () => placeReturn(placed.state, placed.source, { orderNumber: 2 }, ctx),
      'ORDER_NOT_DRAFT',
    );
  });

  it('cancelling a placed return gives the units back', () => {
    const ctx = makeCtx();
    const src = source(ctx);
    const placed = placeReturn(build(src, ctx, '3').state, src, { orderNumber: 1 }, ctx);
    expect(placed.source.lines[0]!.status).toBe('returned');
    const cancelled = voidOrder(
      placed.state,
      { reason: 'customer left', voidedBy: 'u' },
      ctx,
    ).state;
    expect(cancelled.status).toBe('cancelled');
    const released = releaseReturn(cancelled, placed.source, ctx);
    expect(released.state.lines[0]).toMatchObject({ returnedQuantity: '0.0000', status: 'active' });
    expect(released.events[0]!.kind).toBe('return_released');
  });
});

describe('settling a return', () => {
  it('a return is paid with negative amounts and completes', () => {
    const ctx = makeCtx();
    const src = source(ctx);
    const placed = placeReturn(build(src, ctx, '3').state, src, { orderNumber: 1 }, ctx);
    let ret = placed.state;
    rule(
      () => applyPayment(ret, { amountMinor: 1000n, paymentRef: 'x' }, ctx),
      'PAYMENT_AMOUNT_INVALID',
    );
    rule(() => applyPayment(ret, { amountMinor: -1001n, paymentRef: 'x' }, ctx), 'OVERPAYMENT');
    ret = applyPayment(ret, { amountMinor: -400n, paymentRef: 'refund-1' }, ctx).state;
    expect(ret).toMatchObject({ paymentStatus: 'partially_paid', paidMinor: -400n });
    ret = applyPayment(ret, { amountMinor: -600n, paymentRef: 'refund-2' }, ctx).state;
    const done = markPaid(ret, ctx).state;
    expect(done).toMatchObject({
      status: 'completed',
      paymentStatus: 'paid',
      paidMinor: -1000n,
      fulfillmentStatus: 'not_applicable',
    });
    assertDbInvariants(done);
  });

  it('completing a return refunds the source: partially_refunded, then refunded', () => {
    const ctx = makeCtx();
    const src = source(ctx);
    const p1 = placeReturn(build(src, ctx, '1').state, src, { orderNumber: 1 }, ctx);
    const r1 = applyReturnRefundToSource(p1.state, p1.source, ctx);
    expect(r1.state).toMatchObject({
      refundedMinor: 333n,
      paymentStatus: 'partially_refunded',
      status: 'completed',
    });
    expect(r1.state.checks[0]!.refundedMinor).toBe(333n);
    expect(r1.events[0]).toMatchObject({
      kind: 'refund_applied',
      payload: { returnOrderId: p1.state.id },
    });
    const p2 = placeReturn(build(r1.state, ctx, '2').state, r1.state, { orderNumber: 2 }, ctx);
    const r2 = applyReturnRefundToSource(p2.state, p2.source, ctx);
    expect(r2.state).toMatchObject({ refundedMinor: 1000n, paymentStatus: 'refunded' });
  });
});

describe('exchange', () => {
  it('an exchange mixes returned lines with new ones; the customer pays the difference', () => {
    const ctx = makeCtx();
    const src = source(ctx);
    let ex = build(src, ctx, '1', 'exchange').state;
    expect(ex.kind).toBe('exchange');
    ex = addLine(ex, { snapshot: snapshot('Bigger widget', 2000n), quantity: '1' }, ctx).state;
    expect(ex.totalMinor).toBe(2000n - 333n);
    const placed = placeReturn(ex, src, { orderNumber: 1 }, ctx);
    expect(placed.source.lines[0]!.returnedQuantity).toBe('1.0000');
    let o = applyPayment(placed.state, { amountMinor: 1667n, paymentRef: 'diff' }, ctx).state;
    o = markPaid(o, ctx).state;
    expect(o).toMatchObject({ status: 'completed', paymentStatus: 'paid', totalMinor: 1667n });
    // only the returned line refunds the source
    const refunded = applyReturnRefundToSource(o, placed.source, ctx).state;
    expect(refunded.refundedMinor).toBe(333n);
    assertDbInvariants(o);
  });

  it('an exchange of equal value settles at zero', () => {
    const ctx = makeCtx();
    const src = source(ctx);
    let ex = build(src, ctx, '3', 'exchange').state;
    ex = addLine(ex, { snapshot: snapshot('Other widget', 1000n), quantity: '1' }, ctx).state;
    expect(ex.totalMinor).toBe(0n);
    const placed = placeReturn(ex, src, { orderNumber: 1 }, ctx);
    expect(markPaid(placed.state, ctx).state).toMatchObject({
      status: 'completed',
      paymentStatus: 'paid',
    });
  });
});
