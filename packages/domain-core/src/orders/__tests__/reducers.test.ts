import { describe, expect, it } from 'vitest';

import { createOrder } from '../aggregate.js';
import { addCharge, applyDiscount, removeCharge, removeDiscount } from '../discounts.js';
import { mergeChecks, shareLine, splitCheckBySeat, splitCheckByLines } from '../checks.js';
import { addLine, removeLine, updateLine, voidLine } from '../lines.js';
import {
  place,
  resume,
  suspend,
  updateDetails,
  voidOrder,
  advanceFulfillment,
} from '../lifecycle.js';
import { applyPayment, applyRefund, markPaid, reopenOffline } from '../payments.js';
import { OrderRuleError, type OrderState } from '../types.js';
import { add, assertDbInvariants, draft, makeCtx, snapshot, withLines } from './helpers.js';

const throwsRule = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(OrderRuleError);
    expect((e as OrderRuleError).code).toBe(code);
    return;
  }
  throw new Error(`expected OrderRuleError ${code}, nothing thrown`);
};

/** place → pay the whole order on its only check → complete. */
function completed(order: OrderState, ctx = makeCtx(), number = 1): OrderState {
  const placed = place(order, { orderNumber: number }, ctx).state;
  const paid = applyPayment(
    placed,
    { amountMinor: placed.totalMinor, paymentRef: 'pay-1' },
    ctx,
  ).state;
  return markPaid(paid, ctx).state;
}

describe('createOrder', () => {
  it('starts as an unplaced draft with one open check', () => {
    const { state, events } = createOrder(
      {
        tenantId: 't',
        locationId: 'l',
        businessDate: '2026-10-18',
        kind: 'dine_in',
        currency: 'AUD',
      },
      makeCtx(),
    );
    expect(state).toMatchObject({
      status: 'draft',
      fulfillmentStatus: 'unfulfilled',
      paymentStatus: 'unpaid',
      version: 1,
      orderNumber: null,
      pricingMode: 'tax_inclusive',
      channel: 'pos',
      totalMinor: 0n,
    });
    expect(state.checks).toHaveLength(1);
    expect(state.checks[0]).toMatchObject({ number: 1, status: 'open' });
    expect(events.map((e) => e.kind)).toEqual(['created']);
  });

  it('returns and exchanges start not_applicable and must name a source; sales must not', () => {
    const ctx = makeCtx();
    const base = {
      tenantId: 't',
      locationId: 'l',
      businessDate: '2026-10-18',
      currency: 'AUD',
    } as const;
    expect(
      createOrder({ ...base, kind: 'return', sourceOrderId: 's' }, ctx).state.fulfillmentStatus,
    ).toBe('not_applicable');
    throwsRule(() => createOrder({ ...base, kind: 'return' }, ctx), 'RETURN_REQUIRES_SOURCE');
    throwsRule(() => createOrder({ ...base, kind: 'exchange' }, ctx), 'RETURN_REQUIRES_SOURCE');
    throwsRule(
      () => createOrder({ ...base, kind: 'retail_sale', sourceOrderId: 's' }, ctx),
      'SOURCE_ONLY_ON_RETURN',
    );
  });

  it('validates kind, channel, currency, client ref and guest count', () => {
    const ctx = makeCtx();
    const base = {
      tenantId: 't',
      locationId: 'l',
      businessDate: '2026-10-18',
      kind: 'retail_sale',
      currency: 'AUD',
    } as const;
    throwsRule(() => createOrder({ ...base, kind: 'nope' as never }, ctx), 'ORDER_KIND_INVALID');
    throwsRule(
      () => createOrder({ ...base, channel: 'nope' as never }, ctx),
      'ORDER_CHANNEL_INVALID',
    );
    throwsRule(() => createOrder({ ...base, currency: 'aud' }, ctx), 'CURRENCY_INVALID');
    throwsRule(
      () => createOrder({ ...base, clientOrderRef: 'has space' }, ctx),
      'CLIENT_ORDER_REF_INVALID',
    );
    throwsRule(() => createOrder({ ...base, guestCount: -1 }, ctx), 'GUEST_COUNT_INVALID');
    throwsRule(
      () => createOrder({ ...base, pricingMode: 'x' as never }, ctx),
      'PRICING_MODE_INVALID',
    );
    expect(createOrder({ ...base, clientOrderRef: 'R1-000123' }, ctx).state.clientOrderRef).toBe(
      'R1-000123',
    );
  });
});

describe('lines and totals (GST 10 % inclusive stub)', () => {
  it('prices a line: total = quantity × price, GST extracted from the inclusive price', () => {
    const ctx = makeCtx();
    const r = add(draft(ctx), ctx, 'Coffee', 550n, '2');
    expect(r.state.lines[0]).toMatchObject({
      seq: 1,
      quantity: '2.0000',
      totalMinor: 1100n,
      taxMinor: 100n,
    });
    expect(r.state.lines[0]!.taxes[0]).toMatchObject({
      taxName: 'GST',
      rate: '0.100000',
      taxableMinor: 1000n,
      taxMinor: 100n,
      inclusive: true,
    });
    expect(r.state).toMatchObject({
      subtotalMinor: 1100n,
      discountMinor: 0n,
      taxMinor: 100n,
      totalMinor: 1100n,
      version: 2,
    });
    expect(r.events[0]).toMatchObject({ kind: 'line_added' });
    assertDbInvariants(r.state);
  });

  it('adds up several lines and numbers them in sequence', () => {
    const ctx = makeCtx();
    const o = withLines(ctx, [
      ['A', 1100n],
      ['B', 550n],
      ['C', 99n, '3'],
    ]);
    expect(o.lines.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(o.totalMinor).toBe(1100n + 550n + 297n);
    expect(o.taxMinor).toBe(100n + 50n + 27n);
    assertDbInvariants(o);
  });

  it('exclusive pricing adds tax on top; subtotal stays ex-tax', () => {
    const ctx = makeCtx();
    const o = withLines(ctx, [['A', 1000n]], { pricingMode: 'tax_exclusive' });
    expect(o).toMatchObject({ subtotalMinor: 1000n, taxMinor: 100n, totalMinor: 1100n });
    expect(o.lines[0]).toMatchObject({ totalMinor: 1100n, taxMinor: 100n });
    expect(o.lines[0]!.taxes[0]).toMatchObject({ taxableMinor: 1000n, inclusive: false });
    assertDbInvariants(o);
  });

  it('weighed quantities keep four decimals', () => {
    const ctx = makeCtx();
    const o = withLines(ctx, [['Cheese', 1000n, '1.255']]);
    expect(o.lines[0]).toMatchObject({ quantity: '1.2550', totalMinor: 1255n });
  });

  it('a GST-free class carries no tax', () => {
    const ctx = makeCtx();
    const r = addLine(
      draft(ctx),
      { snapshot: snapshot('Bread', 450n, { taxClassCode: 'gst_free' }), quantity: '1' },
      ctx,
    );
    expect(r.state.lines[0]).toMatchObject({ taxMinor: 0n, totalMinor: 450n });
    expect(r.state.lines[0]!.taxes[0]).toMatchObject({
      taxName: 'GST Free',
      rate: '0.000000',
      exemptReason: 'gst_free',
    });
  });

  it('modifiers add to the unit price and are copied onto the line', () => {
    const ctx = makeCtx();
    const r = add(draft(ctx), ctx, 'Burger', 1000n, '1', {
      modifiers: [
        { name: 'Bacon', priceDeltaMinor: 200n },
        { name: 'Extra patty', quantity: 2, priceDeltaMinor: 150n },
        { name: 'No onion' },
      ],
    });
    expect(r.state.lines[0]!.modifiers.map((m) => m.name)).toEqual([
      'Bacon',
      'Extra patty',
      'No onion',
    ]);
    expect(r.state.lines[0]!.totalMinor).toBe(1500n);
    throwsRule(
      () =>
        add(draft(ctx), ctx, 'Cheap', 100n, '1', {
          modifiers: [{ name: 'Deal', priceDeltaMinor: -500n }],
        }),
      'LINE_PRICE_NEGATIVE',
    );
    throwsRule(
      () => add(draft(ctx), ctx, 'X', 100n, '1', { modifiers: [{ name: '' }] }),
      'MODIFIER_NAME_REQUIRED',
    );
    throwsRule(
      () => add(draft(ctx), ctx, 'X', 100n, '1', { modifiers: [{ name: 'm', quantity: 0 }] }),
      'MODIFIER_QUANTITY_INVALID',
    );
  });

  it('a price override needs a reason and keeps the list price', () => {
    const ctx = makeCtx();
    throwsRule(
      () => add(draft(ctx), ctx, 'X', 1000n, '1', { unitPriceMinor: 800n }),
      'PRICE_OVERRIDE_REASON_REQUIRED',
    );
    const r = add(draft(ctx), ctx, 'X', 1000n, '1', {
      unitPriceMinor: 800n,
      priceOverrideReason: 'damaged box',
      priceOverrideApprovalId: 'ap-1',
    });
    expect(r.state.lines[0]).toMatchObject({
      listPriceMinor: 1000n,
      unitPriceMinor: 800n,
      priceOverrideReason: 'damaged box',
      priceOverrideApprovalId: 'ap-1',
      totalMinor: 800n,
    });
    expect(r.events[0]!.approvalId).toBe('ap-1');
    const same = add(draft(ctx), ctx, 'X', 1000n, '1', { unitPriceMinor: 1000n });
    expect(same.state.lines[0]!.priceOverrideReason).toBeNull();
    throwsRule(
      () =>
        add(draft(ctx), ctx, 'X', 1000n, '1', { unitPriceMinor: -1n, priceOverrideReason: 'r' }),
      'LINE_PRICE_NEGATIVE',
    );
  });

  it.each(['0', '0.0000', '-1', '1.00001', 'abc', '', '99999999999'])(
    'rejects quantity %j',
    (q) => {
      const ctx = makeCtx();
      expect(() => add(draft(ctx), ctx, 'X', 100n, q)).toThrow(OrderRuleError);
    },
  );

  it('only draft and open orders accept lines; return orders never do', () => {
    const ctx = makeCtx();
    const o = withLines(ctx, [['A', 100n]]);
    const placed = place(o, { orderNumber: 1 }, ctx).state;
    expect(add(placed, ctx, 'B', 100n).state.lines).toHaveLength(2);
    const suspended = suspend(placed, {}, ctx).state;
    throwsRule(() => add(suspended, ctx, 'B', 100n), 'ORDER_NOT_EDITABLE');
    throwsRule(() => add(completed(o, ctx), ctx, 'B', 100n), 'ORDER_NOT_EDITABLE');
    const ret = createOrder(
      {
        tenantId: 't',
        locationId: 'l',
        businessDate: '2026-10-18',
        kind: 'return',
        currency: 'AUD',
        sourceOrderId: 's',
      },
      ctx,
    ).state;
    throwsRule(() => add(ret, ctx, 'B', 100n), 'RETURN_ORDER_NO_NEW_LINES');
  });

  it('default kitchen status and fulfilment mode follow the order kind', () => {
    const ctx = makeCtx();
    const dine = add(draft(ctx, { kind: 'dine_in' }), ctx, 'Soup', 900n).state.lines[0]!;
    expect(dine).toMatchObject({ kitchenStatus: 'not_sent', fulfillmentMode: 'dine_in' });
    const retail = add(draft(ctx), ctx, 'Mug', 900n).state.lines[0]!;
    expect(retail).toMatchObject({ kitchenStatus: null, fulfillmentMode: 'take' });
    expect(
      add(draft(ctx, { kind: 'delivery' }), ctx, 'Soup', 900n).state.lines[0]!.fulfillmentMode,
    ).toBe('deliver');
  });

  it('updateLine reprices; sent kitchen lines are frozen', () => {
    const ctx = makeCtx();
    const o = withLines(ctx, [['A', 1000n]]);
    const lineId = o.lines[0]!.id;
    const u = updateLine(o, lineId, { quantity: '3', notes: 'to go', seatNumber: 2 }, ctx);
    expect(u.state.lines[0]).toMatchObject({
      quantity: '3.0000',
      totalMinor: 3000n,
      notes: 'to go',
      seatNumber: 2,
    });
    expect(u.state.version).toBe(o.version + 1);
    throwsRule(() => updateLine(o, lineId, { quantity: '0' }, ctx), 'QUANTITY_INVALID');
    throwsRule(
      () => updateLine(o, lineId, { unitPriceMinor: 10n }, ctx),
      'PRICE_OVERRIDE_REASON_REQUIRED',
    );
    throwsRule(() => updateLine(o, 'nope', { quantity: '1' }, ctx), 'LINE_NOT_FOUND');
    const sent = { ...o, lines: o.lines.map((l) => ({ ...l, kitchenStatus: 'sent' as const })) };
    throwsRule(() => updateLine(sent, lineId, { quantity: '2' }, ctx), 'LINE_ALREADY_SENT');
    expect(updateLine(sent, lineId, { notes: 'allergy' }, ctx).state.lines[0]!.notes).toBe(
      'allergy',
    );
  });

  it('removeLine deletes in a draft; a placed order voids instead and the row stays', () => {
    const ctx = makeCtx();
    const o = withLines(ctx, [
      ['A', 1000n],
      ['B', 500n],
    ]);
    const gone = removeLine(o, o.lines[0]!.id, ctx);
    expect(gone.state.lines.map((l) => l.itemSnapshot.name)).toEqual(['B']);
    expect(gone.state.totalMinor).toBe(500n);

    const placed = place(o, { orderNumber: 1 }, ctx).state;
    throwsRule(() => removeLine(placed, placed.lines[0]!.id, ctx), 'USE_VOID_LINE');
    throwsRule(
      () => voidLine(placed, placed.lines[0]!.id, { reason: ' ', voidedBy: 'u' }, ctx),
      'VOID_REASON_REQUIRED',
    );
    const v = voidLine(
      placed,
      placed.lines[0]!.id,
      { reason: 'customer changed mind', approvalId: 'ap-9', voidedBy: 'u-2' },
      ctx,
    );
    expect(v.state.lines[0]).toMatchObject({
      status: 'voided',
      voidReason: 'customer changed mind',
      voidApprovalId: 'ap-9',
      voidedBy: 'u-2',
    });
    expect(v.state.lines).toHaveLength(2);
    expect(v.state.totalMinor).toBe(500n);
    expect(v.events[0]).toMatchObject({ kind: 'line_voided', approvalId: 'ap-9' });
    throwsRule(
      () => voidLine(v.state, v.state.lines[0]!.id, { reason: 'again', voidedBy: 'u' }, ctx),
      'LINE_NOT_ACTIVE',
    );
    throwsRule(
      () => voidLine(o, o.lines[0]!.id, { reason: 'r', voidedBy: 'u' }, ctx),
      'ORDER_NOT_OPEN',
    );
    assertDbInvariants(v.state);
  });

  it('voiding a sent kitchen line cancels it at the kitchen and takes its components with it', () => {
    const ctx = makeCtx();
    let o = draft(ctx, { kind: 'dine_in' });
    o = add(o, ctx, 'Combo', 1500n).state;
    o = add(o, ctx, 'Fries', 0n, '1', { parentLineId: o.lines[0]!.id }).state;
    o = place(o, { orderNumber: 1 }, ctx).state;
    o = { ...o, lines: o.lines.map((l) => ({ ...l, kitchenStatus: 'sent' as const })) };
    const v = voidLine(o, o.lines[0]!.id, { reason: 'wrong table', voidedBy: 'u' }, ctx);
    expect(v.state.lines.map((l) => [l.status, l.kitchenStatus])).toEqual([
      ['voided', 'cancelled'],
      ['voided', 'cancelled'],
    ]);
    expect(v.events[0]!.payload).toMatchObject({ wasSent: true });
  });
});

describe('discounts', () => {
  it('an order discount is allocated across lines and the shares add up exactly', () => {
    const ctx = makeCtx();
    const o = withLines(ctx, [
      ['A', 1000n],
      ['B', 1000n],
      ['C', 1000n],
    ]);
    const r = applyDiscount(o, { amountMinor: 100n, description: 'Loyalty', appliedBy: 'u' }, ctx);
    expect(r.state.lines.map((l) => l.discountMinor)).toEqual([34n, 33n, 33n]);
    expect(r.state.discountMinor).toBe(100n);
    expect(r.state.totalMinor).toBe(2900n);
    expect(r.state.discounts[0]!.amountMinor).toBe(100n);
    expect(r.events[0]).toMatchObject({ kind: 'discount_applied' });
    assertDbInvariants(r.state);
  });

  it('a percent discount resolves to an amount and follows later changes', () => {
    const ctx = makeCtx();
    let o = withLines(ctx, [['A', 1000n]]);
    o = applyDiscount(
      o,
      { percent: '10', description: 'Staff', kind: 'employee', appliedBy: 'u' },
      ctx,
    ).state;
    expect(o.discounts[0]).toMatchObject({ percent: '10', amountMinor: 100n });
    expect(o.totalMinor).toBe(900n);
    o = add(o, ctx, 'B', 1000n).state;
    expect(o.discounts[0]!.amountMinor).toBe(200n);
    expect(o.totalMinor).toBe(1800n);
    expect(o.taxMinor).toBe(164n); // GST on 1800 incl. = 163.6 → 164
  });

  it('a line discount only touches its line', () => {
    const ctx = makeCtx();
    const o = withLines(ctx, [
      ['A', 1000n],
      ['B', 1000n],
    ]);
    const r = applyDiscount(
      o,
      { lineId: o.lines[0]!.id, percent: '50', description: 'Damaged', appliedBy: 'u' },
      ctx,
    );
    expect(r.state.lines.map((l) => l.discountMinor)).toEqual([500n, 0n]);
    expect(r.state.totalMinor).toBe(1500n);
  });

  it('never exceeds what is left, and an empty order has nothing to discount', () => {
    const ctx = makeCtx();
    const o = withLines(ctx, [['A', 1000n]]);
    const r = applyDiscount(
      o,
      { amountMinor: 5000n, description: 'Too much', appliedBy: 'u' },
      ctx,
    );
    expect(r.state.discounts[0]!.amountMinor).toBe(1000n);
    expect(r.state.totalMinor).toBe(0n);
    throwsRule(
      () => applyDiscount(draft(ctx), { amountMinor: 100n, description: 'x', appliedBy: 'u' }, ctx),
      'DISCOUNT_NO_EFFECT',
    );
  });

  it('stacked discounts apply one after the other on what is left', () => {
    const ctx = makeCtx();
    let o = withLines(ctx, [['A', 1000n]]);
    o = applyDiscount(o, { percent: '50', description: 'a', appliedBy: 'u' }, ctx).state;
    o = applyDiscount(o, { percent: '50', description: 'b', appliedBy: 'u' }, ctx).state;
    expect(o.discounts.map((d) => d.amountMinor)).toEqual([500n, 250n]);
    expect(o.totalMinor).toBe(250n);
  });

  it('validates the discount specification', () => {
    const ctx = makeCtx();
    const o = withLines(ctx, [['A', 1000n]]);
    const d = (patch: object) => () =>
      applyDiscount(o, { description: 'x', appliedBy: 'u', ...patch }, ctx);
    throwsRule(d({}), 'DISCOUNT_VALUE_INVALID');
    throwsRule(d({ percent: '10', amountMinor: 5n }), 'DISCOUNT_VALUE_INVALID');
    throwsRule(d({ amountMinor: 0n }), 'DISCOUNT_VALUE_INVALID');
    throwsRule(d({ percent: '0' }), 'DISCOUNT_PERCENT_INVALID');
    throwsRule(d({ percent: '100.01' }), 'DISCOUNT_PERCENT_INVALID');
    throwsRule(d({ percent: '10.00001' }), 'DISCOUNT_PERCENT_INVALID');
    throwsRule(d({ percent: '10', kind: 'nope' }), 'DISCOUNT_KIND_INVALID');
    throwsRule(d({ percent: '10', description: ' ' }), 'DISCOUNT_DESCRIPTION_REQUIRED');
    throwsRule(d({ percent: '10', lineId: 'nope' }), 'LINE_NOT_FOUND');
  });

  it('removing a discount restores the totals; order-level changes stop once money was taken', () => {
    const ctx = makeCtx();
    let o = withLines(ctx, [['A', 1000n]]);
    o = applyDiscount(o, { percent: '10', description: 'x', appliedBy: 'u' }, ctx).state;
    const removed = removeDiscount(o, o.discounts[0]!.id, ctx);
    expect(removed.state.totalMinor).toBe(1000n);
    throwsRule(() => removeDiscount(o, 'nope', ctx), 'DISCOUNT_NOT_FOUND');

    const placed = place(o, { orderNumber: 1 }, ctx).state;
    const part = applyPayment(placed, { amountMinor: 100n, paymentRef: 'p' }, ctx).state;
    throwsRule(() => removeDiscount(part, part.discounts[0]!.id, ctx), 'ORDER_HAS_PAYMENTS');
    throwsRule(
      () => applyDiscount(part, { percent: '5', description: 'late', appliedBy: 'u' }, ctx),
      'ORDER_HAS_PAYMENTS',
    );
  });
});

describe('charges', () => {
  it('a fixed surcharge adds to the total with its own GST', () => {
    const ctx = makeCtx();
    const o = withLines(ctx, [['A', 1000n]]);
    const r = addCharge(
      o,
      { kind: 'surcharge', description: 'Public holiday', amountMinor: 200n },
      ctx,
    );
    expect(r.state.charges[0]).toMatchObject({ amountMinor: 200n, taxMinor: 18n });
    expect(r.state).toMatchObject({ chargesMinor: 200n, totalMinor: 1200n, taxMinor: 91n + 18n });
    assertDbInvariants(r.state);
  });

  it('a percent service charge follows the check and is not taxed when marked untaxable', () => {
    const ctx = makeCtx();
    let o = withLines(ctx, [['A', 1000n]], { kind: 'dine_in' });
    o = addCharge(
      o,
      { kind: 'service_charge', description: '10 %', percent: '10', taxable: false },
      ctx,
    ).state;
    expect(o.charges[0]).toMatchObject({ amountMinor: 100n, taxMinor: 0n });
    o = add(o, ctx, 'B', 1000n).state;
    expect(o.charges[0]!.amountMinor).toBe(200n);
    expect(o.totalMinor).toBe(2200n);
    expect(o.charges[0]!.isGratuity).toBe(false);
    expect(
      addCharge(o, { kind: 'gratuity', description: 'tip', amountMinor: 50n }, ctx).state
        .charges[1]!.isGratuity,
    ).toBe(true);
    const removed = removeCharge(o, o.charges[0]!.id, ctx);
    expect(removed.state.totalMinor).toBe(2000n);
    throwsRule(() => removeCharge(o, 'nope', ctx), 'CHARGE_NOT_FOUND');
  });

  it('exclusive pricing: charge tax is added through tax_minor', () => {
    const ctx = makeCtx();
    const o = withLines(ctx, [['A', 1000n]], { pricingMode: 'tax_exclusive' });
    const r = addCharge(
      o,
      { kind: 'delivery_fee', description: 'Delivery', amountMinor: 500n },
      ctx,
    );
    expect(r.state).toMatchObject({ chargesMinor: 500n, taxMinor: 150n, totalMinor: 1650n });
    assertDbInvariants(r.state);
  });

  it('validates the charge specification', () => {
    const ctx = makeCtx();
    const o = withLines(ctx, [['A', 1000n]]);
    const c = (patch: object) => () =>
      addCharge(o, { kind: 'surcharge', description: 'x', ...patch } as never, ctx);
    throwsRule(c({}), 'CHARGE_VALUE_INVALID');
    throwsRule(c({ amountMinor: -1n }), 'CHARGE_VALUE_INVALID');
    throwsRule(c({ amountMinor: 1n, percent: '5' }), 'CHARGE_VALUE_INVALID');
    throwsRule(c({ amountMinor: 1n, kind: 'nope' }), 'CHARGE_KIND_INVALID');
    throwsRule(c({ amountMinor: 1n, description: '' }), 'CHARGE_DESCRIPTION_REQUIRED');
  });
});

describe('lifecycle', () => {
  it('place assigns the canonical number, opens the order and refuses an empty one', () => {
    const ctx = makeCtx();
    throwsRule(() => place(draft(ctx), { orderNumber: 1 }, ctx), 'EMPTY_ORDER');
    const o = withLines(ctx, [['A', 1000n]], { clientOrderRef: 'R1-000123' });
    const r = place(o, { orderNumber: 42, businessDate: '2026-10-19' }, ctx);
    expect(r.state).toMatchObject({
      status: 'open',
      orderNumber: 42,
      clientOrderRef: 'R1-000123',
      businessDate: '2026-10-19',
    });
    expect(r.state.placedAt).not.toBeNull();
    expect(r.events[0]).toMatchObject({ kind: 'placed', fromStatus: 'draft', toStatus: 'open' });
    throwsRule(() => place(r.state, { orderNumber: 43 }, ctx), 'ILLEGAL_STATUS_TRANSITION');
    throwsRule(() => place(o, { orderNumber: 0 }, ctx), 'ORDER_NUMBER_INVALID');
    throwsRule(
      () => place({ ...o, orderNumber: 7 }, { orderNumber: 8 }, ctx),
      'ORDER_NUMBER_ALREADY_ASSIGNED',
    );
  });

  it('return and exchange orders cannot use plain place', () => {
    const ctx = makeCtx();
    const ret = createOrder(
      {
        tenantId: 't',
        locationId: 'l',
        businessDate: '2026-10-18',
        kind: 'return',
        currency: 'AUD',
        sourceOrderId: 's',
      },
      ctx,
    ).state;
    throwsRule(() => place(ret, { orderNumber: 1 }, ctx), 'RETURN_REQUIRES_SOURCE');
  });

  it('suspend and resume only on open orders without payments', () => {
    const ctx = makeCtx();
    const o = withLines(ctx, [['A', 1000n]]);
    throwsRule(() => suspend(o, {}, ctx), 'ILLEGAL_STATUS_TRANSITION'); // a draft is not suspended; it is placed first
    const placed = place(o, { orderNumber: 1 }, ctx).state;
    const s = suspend(placed, { reason: 'customer fetching wallet' }, ctx);
    expect(s.state.status).toBe('suspended');
    expect(s.events[0]).toMatchObject({
      kind: 'suspended',
      toStatus: 'suspended',
      payload: { reason: 'customer fetching wallet' },
    });
    const r = resume(s.state, ctx);
    expect(r.state.status).toBe('open');
    expect(r.events[0]).toMatchObject({ kind: 'resumed', fromStatus: 'suspended' });
    throwsRule(() => resume(placed, ctx), 'ILLEGAL_STATUS_TRANSITION');
    const part = applyPayment(placed, { amountMinor: 100n, paymentRef: 'p' }, ctx).state;
    throwsRule(() => suspend(part, {}, ctx), 'ORDER_HAS_PAYMENTS');
  });

  it('void: a draft is cancelled, an unpaid open order is cancelled with its lines, a paid one needs a refund first', () => {
    const ctx = makeCtx();
    const o = withLines(ctx, [['A', 1000n]]);
    throwsRule(() => voidOrder(o, { reason: '', voidedBy: 'u' }, ctx), 'VOID_REASON_REQUIRED');
    const c = voidOrder(o, { reason: 'abandoned', voidedBy: 'u' }, ctx);
    expect(c.state).toMatchObject({ status: 'cancelled', voidReason: 'abandoned' });
    expect(c.state.cancelledAt).not.toBeNull();
    expect(c.events[0]).toMatchObject({ kind: 'cancelled', fromStatus: 'draft' });
    expect(c.state.lines.every((l) => l.status === 'cancelled')).toBe(true);
    expect(c.state.checks.every((k) => k.status === 'voided')).toBe(true);
    throwsRule(
      () => voidOrder(c.state, { reason: 'again', voidedBy: 'u' }, ctx),
      'ILLEGAL_STATUS_TRANSITION',
    );

    const placed = place(o, { orderNumber: 1 }, ctx).state;
    expect(
      voidOrder(placed, { reason: 'wrong table', approvalId: 'ap', voidedBy: 'u' }, ctx).state
        .voidApprovalId,
    ).toBe('ap');
    const part = applyPayment(placed, { amountMinor: 100n, paymentRef: 'p' }, ctx).state;
    throwsRule(() => voidOrder(part, { reason: 'x', voidedBy: 'u' }, ctx), 'REFUND_FIRST');
    throwsRule(
      () => voidOrder(suspend(placed, {}, ctx).state, { reason: 'x', voidedBy: 'u' }, ctx),
      'ORDER_SUSPENDED',
    );
  });

  it('void: a completed order becomes voided with the approval that allowed it', () => {
    const ctx = makeCtx();
    const done = completed(withLines(ctx, [['A', 1000n]]), ctx);
    const v = voidOrder(
      done,
      { reason: 'duplicate sale', approvalId: 'ap-1', voidedBy: 'mgr' },
      ctx,
    );
    expect(v.state).toMatchObject({
      status: 'voided',
      voidReason: 'duplicate sale',
      voidApprovalId: 'ap-1',
      paymentStatus: 'paid',
    });
    expect(v.state.voidedAt).not.toBeNull();
    expect(v.events[0]).toMatchObject({
      kind: 'voided',
      fromStatus: 'completed',
      toStatus: 'voided',
      approvalId: 'ap-1',
    });
    const returned = {
      ...done,
      lines: done.lines.map((l) => ({ ...l, returnedQuantity: '1.0000' })),
    };
    throwsRule(() => voidOrder(returned, { reason: 'x', voidedBy: 'u' }, ctx), 'ORDER_HAS_RETURNS');
    const ret = { ...done, kind: 'return' as const };
    throwsRule(
      () => voidOrder(ret, { reason: 'x', voidedBy: 'u' }, ctx),
      'RETURN_CANNOT_BE_VOIDED',
    );
  });

  it('updateDetails: notes, guests, customer and metadata until the order is finished', () => {
    const ctx = makeCtx();
    const o = withLines(ctx, [['A', 1000n]]);
    const r = updateDetails(
      o,
      { notes: 'birthday', guestCount: 4, customerId: 'cust-1', metadata: { table: 'T4' } },
      ctx,
    );
    expect(r.state).toMatchObject({
      notes: 'birthday',
      guestCount: 4,
      customerId: 'cust-1',
      metadata: { table: 'T4' },
    });
    expect(r.events[0]!.kind).toBe('order_updated');
    expect(updateDetails(o, { notes: 'only a note' }, ctx).events[0]!.kind).toBe('note_added');
    throwsRule(() => updateDetails(o, { guestCount: -2 }, ctx), 'GUEST_COUNT_INVALID');
    throwsRule(() => updateDetails(completed(o, ctx), { notes: 'x' }, ctx), 'ORDER_NOT_EDITABLE');
  });

  it('fulfilment follows its own table on placed orders', () => {
    const ctx = makeCtx();
    const placed = place(
      withLines(ctx, [['A', 1000n]], { kind: 'dine_in' }),
      { orderNumber: 1 },
      ctx,
    ).state;
    let o = advanceFulfillment(placed, 'in_preparation', ctx).state;
    o = advanceFulfillment(o, 'partially_ready', ctx).state;
    o = advanceFulfillment(o, 'ready', ctx).state;
    o = advanceFulfillment(o, 'fulfilled', ctx).state;
    expect(o.fulfillmentStatus).toBe('fulfilled');
    throwsRule(
      () => advanceFulfillment(o, 'in_preparation', ctx),
      'ILLEGAL_FULFILLMENT_TRANSITION',
    );
    throwsRule(
      () => advanceFulfillment(withLines(ctx, [['A', 1n]]), 'ready', ctx),
      'ORDER_NOT_PLACED',
    );
  });
});

describe('checks: split, merge, shared items', () => {
  const restaurant = (ctx = makeCtx()) => {
    let o = draft(ctx, { kind: 'dine_in' });
    o = add(o, ctx, 'Steak', 3000n, '1', { seatNumber: 1 }).state;
    o = add(o, ctx, 'Salad', 1500n, '1', { seatNumber: 2 }).state;
    o = add(o, ctx, 'Wine', 2000n, '1', { seatNumber: 2 }).state;
    return { o, ctx };
  };

  it('split by lines moves them to a new check and keeps the order total', () => {
    const { o, ctx } = restaurant();
    const r = splitCheckByLines(
      o,
      { fromCheckId: o.checks[0]!.id, lineIds: [o.lines[0]!.id], label: 'Alice' },
      ctx,
    );
    expect(r.state.checks).toHaveLength(2);
    expect(r.state.checks[1]).toMatchObject({ number: 2, label: 'Alice', totalMinor: 3000n });
    expect(r.state.checks[0]!.totalMinor).toBe(3500n);
    expect(r.state.totalMinor).toBe(o.totalMinor);
    expect(r.events[0]).toMatchObject({
      kind: 'check_split',
      payload: { mode: 'lines', createdCheck: true },
    });
    assertDbInvariants(r.state);
    // into an existing check
    const back = splitCheckByLines(
      r.state,
      {
        fromCheckId: r.state.checks[1]!.id,
        lineIds: [o.lines[0]!.id],
        toCheckId: r.state.checks[0]!.id,
      },
      ctx,
    );
    expect(back.state.checks[0]!.totalMinor).toBe(6500n);
    expect(back.state.checks[1]!.totalMinor).toBe(0n);
  });

  it('split by seat moves every line at those seats', () => {
    const { o, ctx } = restaurant();
    const r = splitCheckBySeat(o, { fromCheckId: o.checks[0]!.id, seatNumbers: [2] }, ctx);
    expect(r.state.checks[1]!.totalMinor).toBe(3500n);
    expect(r.state.lines.filter((l) => l.checkId === r.state.checks[1]!.id)).toHaveLength(2);
    throwsRule(
      () => splitCheckBySeat(o, { fromCheckId: o.checks[0]!.id, seatNumbers: [9] }, ctx),
      'NOTHING_TO_SPLIT',
    );
  });

  it('rejects bad splits', () => {
    const { o, ctx } = restaurant();
    const from = o.checks[0]!.id;
    throwsRule(
      () => splitCheckByLines(o, { fromCheckId: from, lineIds: [] }, ctx),
      'NOTHING_TO_SPLIT',
    );
    throwsRule(
      () => splitCheckByLines(o, { fromCheckId: from, lineIds: ['nope'] }, ctx),
      'LINE_NOT_FOUND',
    );
    throwsRule(
      () => splitCheckByLines(o, { fromCheckId: 'nope', lineIds: [o.lines[0]!.id] }, ctx),
      'CHECK_NOT_FOUND',
    );
    throwsRule(
      () =>
        splitCheckByLines(
          o,
          { fromCheckId: from, lineIds: [o.lines[0]!.id], toCheckId: from },
          ctx,
        ),
      'SPLIT_SAME_CHECK',
    );
    const two = splitCheckByLines(o, { fromCheckId: from, lineIds: [o.lines[0]!.id] }, ctx).state;
    throwsRule(
      () =>
        splitCheckByLines(
          two,
          { fromCheckId: two.checks[1]!.id, lineIds: [two.lines[1]!.id] },
          ctx,
        ),
      'LINE_NOT_ON_CHECK',
    );
  });

  it('a check that took money is frozen', () => {
    const { o, ctx } = restaurant();
    const split = splitCheckByLines(
      o,
      { fromCheckId: o.checks[0]!.id, lineIds: [o.lines[0]!.id] },
      ctx,
    ).state;
    const placed = place(split, { orderNumber: 1 }, ctx).state;
    const paid = applyPayment(
      placed,
      { checkId: placed.checks[1]!.id, amountMinor: 3000n, paymentRef: 'p1' },
      ctx,
    ).state;
    expect(paid.checks[1]).toMatchObject({ status: 'closed', paidMinor: 3000n });
    throwsRule(() => updateLine(paid, paid.lines[0]!.id, { quantity: '2' }, ctx), 'CHECK_NOT_OPEN');
    throwsRule(
      () =>
        mergeChecks(
          paid,
          { sourceCheckId: paid.checks[1]!.id, targetCheckId: paid.checks[0]!.id },
          ctx,
        ),
      'CHECK_NOT_OPEN',
    );
    // a new line goes to the still-open check
    const added = add(paid, ctx, 'Coffee', 400n).state;
    expect(added.lines.at(-1)!.checkId).toBe(paid.checks[0]!.id);
  });

  it('merge moves lines and charges to the target and voids the emptied check', () => {
    const { o, ctx } = restaurant();
    let s = splitCheckBySeat(o, { fromCheckId: o.checks[0]!.id, seatNumbers: [2] }, ctx).state;
    s = addCharge(
      s,
      { kind: 'surcharge', description: 'x', amountMinor: 100n, checkId: s.checks[1]!.id },
      ctx,
    ).state;
    const total = s.totalMinor;
    const m = mergeChecks(
      s,
      { sourceCheckId: s.checks[1]!.id, targetCheckId: s.checks[0]!.id },
      ctx,
    );
    expect(m.state.checks[1]).toMatchObject({ status: 'voided', totalMinor: 0n });
    expect(m.state.checks[0]!.totalMinor).toBe(total);
    expect(m.state.charges[0]!.checkId).toBe(s.checks[0]!.id);
    expect(m.state.totalMinor).toBe(total);
    expect(m.events[0]).toMatchObject({ kind: 'check_merged' });
    throwsRule(
      () =>
        mergeChecks(
          m.state,
          { sourceCheckId: s.checks[0]!.id, targetCheckId: s.checks[0]!.id },
          ctx,
        ),
      'MERGE_SAME_CHECK',
    );
    throwsRule(
      () =>
        mergeChecks(
          m.state,
          { sourceCheckId: s.checks[1]!.id, targetCheckId: s.checks[0]!.id },
          ctx,
        ),
      'CHECK_NOT_OPEN',
    );
    assertDbInvariants(m.state);
  });

  it('a shared line splits into fractional portions that add up to the original to the cent', () => {
    const ctx = makeCtx();
    let o = draft(ctx, { kind: 'dine_in' });
    o = add(o, ctx, 'Pizza', 1000n).state;
    const before = o.totalMinor;
    const r = shareLine(o, { lineId: o.lines[0]!.id, parts: 3 }, ctx);
    const portions = r.state.lines;
    expect(portions.map((l) => l.quantity)).toEqual(['0.3334', '0.3333', '0.3333']);
    expect(portions.reduce((a, l) => a + (l.grossOverrideMinor ?? 0n), 0n)).toBe(1000n);
    expect(r.state.totalMinor).toBe(before);
    expect(r.state.checks).toHaveLength(3);
    expect(new Set(portions.map((l) => l.checkId)).size).toBe(3);
    expect(portions[1]!.metadata).toMatchObject({
      sharedFromLineId: o.lines[0]!.id,
      sharePortion: 1,
    });
    expect(r.events[0]!.kind).toBe('line_shared');
    assertDbInvariants(r.state);
    // portions have a fixed amount
    throwsRule(
      () => updateLine(r.state, portions[1]!.id, { quantity: '1' }, ctx),
      'LINE_AMOUNT_FIXED',
    );
  });

  it('explicit shares must add up; a percent line discount follows the portions', () => {
    const ctx = makeCtx();
    let o = draft(ctx, { kind: 'dine_in' });
    o = add(o, ctx, 'Platter', 2000n, '2').state;
    o = applyDiscount(
      o,
      { lineId: o.lines[0]!.id, percent: '10', description: 'Happy hour', appliedBy: 'u' },
      ctx,
    ).state;
    expect(o.totalMinor).toBe(3600n);
    throwsRule(
      () =>
        shareLine(
          o,
          {
            lineId: o.lines[0]!.id,
            shares: [{ quantity: '1' }, { quantity: '0.5', label: 'Bob' }],
          },
          ctx,
        ),
      'SHARE_QUANTITY_MISMATCH',
    );
    const r = shareLine(
      o,
      { lineId: o.lines[0]!.id, shares: [{ quantity: '0.5' }, { quantity: '1.5', label: 'Bob' }] },
      ctx,
    );
    expect(r.state.totalMinor).toBe(3600n);
    expect(r.state.discounts).toHaveLength(2);
    expect(r.state.discounts.map((d) => [d.percent, d.amountMinor])).toEqual([
      [null, 100n],
      [null, 300n],
    ]);
    expect(r.state.lines.map((l) => l.totalMinor)).toEqual([900n, 2700n]);
    expect(r.state.checks.map((c) => c.totalMinor)).toEqual([900n, 2700n]);
    assertDbInvariants(r.state);
  });

  it('splitting a bill gives the new check its own copy of a percent service charge', () => {
    const ctx = makeCtx();
    let o = draft(ctx, { kind: 'dine_in' });
    o = add(o, ctx, 'Steak', 3000n, '1', { seatNumber: 1 }).state;
    o = add(o, ctx, 'Salad', 1000n, '1', { seatNumber: 2 }).state;
    o = addCharge(
      o,
      { kind: 'service_charge', description: '10 % service', percent: '10', taxable: false },
      ctx,
    ).state;
    expect(o.totalMinor).toBe(4400n);
    const s = splitCheckBySeat(o, { fromCheckId: o.checks[0]!.id, seatNumbers: [2] }, ctx);
    expect(s.state.charges).toHaveLength(2);
    expect(s.state.checks.map((c) => [c.chargesMinor, c.totalMinor])).toEqual([
      [300n, 3300n],
      [100n, 1100n],
    ]);
    expect(s.state.totalMinor).toBe(4400n);
    // merging back does not double the charge
    const m = mergeChecks(
      s.state,
      { sourceCheckId: s.state.checks[1]!.id, targetCheckId: s.state.checks[0]!.id },
      ctx,
    );
    expect(m.state.charges).toHaveLength(1);
    expect(m.state.totalMinor).toBe(4400n);
    // a fixed charge is not copied
    const fixed = addCharge(
      o,
      { kind: 'surcharge', description: 'fixed', amountMinor: 50n },
      ctx,
    ).state;
    const f = splitCheckBySeat(fixed, { fromCheckId: fixed.checks[0]!.id, seatNumbers: [2] }, ctx);
    expect(f.state.charges.filter((c) => c.percent === null)).toHaveLength(1);
  });

  it('rejects malformed sharing', () => {
    const ctx = makeCtx();
    const o = add(draft(ctx), ctx, 'Pizza', 1000n, '2').state;
    const id = o.lines[0]!.id;
    throwsRule(() => shareLine(o, { lineId: id }, ctx), 'SHARE_INPUT_INVALID');
    throwsRule(() => shareLine(o, { lineId: id, parts: 1 }, ctx), 'SHARE_INPUT_INVALID');
    throwsRule(
      () => shareLine(o, { lineId: id, parts: 2, shares: [] }, ctx),
      'SHARE_INPUT_INVALID',
    );
    throwsRule(
      () => shareLine(o, { lineId: id, shares: [{ quantity: '2' }] }, ctx),
      'SHARE_INPUT_INVALID',
    );
    throwsRule(
      () =>
        shareLine(
          o,
          { lineId: id, shares: [{ quantity: '2' }, { quantity: '0', label: 'b' }] },
          ctx,
        ),
      'SHARE_QUANTITY_INVALID',
    );
    throwsRule(() => shareLine(o, { lineId: 'nope', parts: 2 }, ctx), 'LINE_NOT_FOUND');
  });

  it('a shared line can be shared again without losing a cent', () => {
    const ctx = makeCtx();
    let o = draft(ctx, { kind: 'dine_in' });
    o = add(o, ctx, 'Cake', 1001n).state;
    const total = o.totalMinor;
    o = shareLine(o, { lineId: o.lines[0]!.id, parts: 2 }, ctx).state;
    o = shareLine(o, { lineId: o.lines[0]!.id, parts: 3 }, ctx).state;
    expect(o.lines).toHaveLength(4);
    expect(o.totalMinor).toBe(total);
    expect(o.lines.reduce((a, l) => a + Number(l.quantity), 0)).toBeCloseTo(1, 4);
    assertDbInvariants(o);
  });
});

describe('payments, completion, refunds', () => {
  const placedOrder = (
    items: ReadonlyArray<[string, bigint, string?]> = [['A', 1000n]],
    ctx = makeCtx(),
  ) => ({ o: place(withLines(ctx, items), { orderNumber: 1 }, ctx).state, ctx });

  it('part payment → partially_paid; the rest closes the check; markPaid completes a retail sale', () => {
    const { o, ctx } = placedOrder();
    const p1 = applyPayment(o, { amountMinor: 400n, paymentRef: 'p1', method: 'card' }, ctx);
    expect(p1.state).toMatchObject({
      paidMinor: 400n,
      paymentStatus: 'partially_paid',
      status: 'open',
    });
    expect(p1.state.checks[0]).toMatchObject({ status: 'open', paidMinor: 400n });
    expect(p1.events[0]).toMatchObject({
      kind: 'payment_applied',
      payload: { paymentRef: 'p1', dueMinor: '600', checkClosed: false },
    });
    throwsRule(() => markPaid(p1.state, ctx), 'ORDER_NOT_FULLY_PAID');
    const p2 = applyPayment(p1.state, { amountMinor: 600n, paymentRef: 'p2' }, ctx);
    expect(p2.state).toMatchObject({ paymentStatus: 'paid', status: 'open' });
    expect(p2.state.checks[0]).toMatchObject({ status: 'closed' });
    const done = markPaid(p2.state, ctx);
    expect(done.state).toMatchObject({
      status: 'completed',
      paymentStatus: 'paid',
      fulfillmentStatus: 'fulfilled',
    });
    expect(done.state.completedAt).not.toBeNull();
    expect(done.events[0]).toMatchObject({
      kind: 'completed',
      fromStatus: 'open',
      toStatus: 'completed',
    });
    assertDbInvariants(done.state);
  });

  it('a restaurant order keeps its fulfilment status when it completes', () => {
    const ctx = makeCtx();
    const o = place(
      withLines(ctx, [['A', 1000n]], { kind: 'dine_in' }),
      { orderNumber: 1 },
      ctx,
    ).state;
    const done = markPaid(
      applyPayment(o, { amountMinor: 1000n, paymentRef: 'p' }, ctx).state,
      ctx,
    ).state;
    expect(done.fulfillmentStatus).toBe('unfulfilled');
  });

  it('rejects overpayment, wrong sign, zero and payments outside an open order', () => {
    const { o, ctx } = placedOrder();
    throwsRule(() => applyPayment(o, { amountMinor: 1001n, paymentRef: 'p' }, ctx), 'OVERPAYMENT');
    throwsRule(
      () => applyPayment(o, { amountMinor: -5n, paymentRef: 'p' }, ctx),
      'PAYMENT_AMOUNT_INVALID',
    );
    throwsRule(
      () => applyPayment(o, { amountMinor: 0n, paymentRef: 'p' }, ctx),
      'PAYMENT_AMOUNT_INVALID',
    );
    const settled = applyPayment(o, { amountMinor: 1000n, paymentRef: 'full' }, ctx).state;
    throwsRule(
      () => applyPayment(settled, { amountMinor: 1n, paymentRef: 'extra' }, ctx),
      'NOTHING_DUE',
    );
    throwsRule(
      () => applyPayment(o, { amountMinor: 5n, paymentRef: '' }, ctx),
      'PAYMENT_REF_REQUIRED',
    );
    throwsRule(
      () => applyPayment(o, { amountMinor: 5n, paymentRef: 'p', tipMinor: -1n }, ctx),
      'TIP_INVALID',
    );
    const draftOrder = withLines(ctx, [['A', 1000n]]);
    throwsRule(
      () => applyPayment(draftOrder, { amountMinor: 5n, paymentRef: 'p' }, ctx),
      'ORDER_NOT_OPEN',
    );
    throwsRule(
      () => applyPayment(suspend(o, {}, ctx).state, { amountMinor: 5n, paymentRef: 'p' }, ctx),
      'ORDER_NOT_OPEN',
    );
  });

  it('tip and cash rounding change what the check totals; the payment covers them', () => {
    const { o, ctx } = placedOrder([['A', 1883n]]);
    const r = applyPayment(
      o,
      {
        amountMinor: 1885n + 100n,
        tipMinor: 100n,
        roundingMinor: 2n,
        paymentRef: 'cash-1',
        method: 'cash',
      },
      ctx,
    );
    expect(r.state.checks[0]).toMatchObject({
      tipMinor: 100n,
      roundingMinor: 2n,
      totalMinor: 1985n,
      paidMinor: 1985n,
      status: 'closed',
    });
    expect(r.state).toMatchObject({
      tipMinor: 100n,
      roundingMinor: 2n,
      totalMinor: 1985n,
      paymentStatus: 'paid',
    });
    assertDbInvariants(r.state);
    expect(markPaid(r.state, ctx).state.status).toBe('completed');
  });

  it('with several checks the check must be named; each check is paid on its own', () => {
    const ctx = makeCtx();
    let o = draft(ctx, { kind: 'dine_in' });
    o = add(o, ctx, 'Steak', 3000n, '1', { seatNumber: 1 }).state;
    o = add(o, ctx, 'Salad', 1500n, '1', { seatNumber: 2 }).state;
    o = splitCheckBySeat(o, { fromCheckId: o.checks[0]!.id, seatNumbers: [2] }, ctx).state;
    o = place(o, { orderNumber: 5 }, ctx).state;
    throwsRule(
      () => applyPayment(o, { amountMinor: 100n, paymentRef: 'p' }, ctx),
      'CHECK_REQUIRED',
    );
    o = applyPayment(
      o,
      { checkId: o.checks[0]!.id, amountMinor: 3000n, paymentRef: 'p1' },
      ctx,
    ).state;
    expect(o.paymentStatus).toBe('partially_paid');
    throwsRule(() => markPaid(o, ctx), 'ORDER_NOT_FULLY_PAID');
    o = applyPayment(
      o,
      { checkId: o.checks[1]!.id, amountMinor: 1500n, paymentRef: 'p2' },
      ctx,
    ).state;
    expect(markPaid(o, ctx).state).toMatchObject({ status: 'completed', paymentStatus: 'paid' });
  });

  it('a zero-total order settles with markPaid and is paid', () => {
    const ctx = makeCtx();
    let o = withLines(ctx, [['Freebie', 500n]], { kind: 'staff_meal' });
    o = applyDiscount(
      o,
      { percent: '100', description: 'Staff meal', kind: 'employee', appliedBy: 'u' },
      ctx,
    ).state;
    o = place(o, { orderNumber: 1 }, ctx).state;
    expect(o.totalMinor).toBe(0n);
    throwsRule(
      () => applyPayment(o, { amountMinor: 10n, paymentRef: 'p' }, ctx),
      'CHECK_HAS_NOTHING_DUE',
    );
    const done = markPaid(o, ctx).state;
    expect(done).toMatchObject({ status: 'completed', paymentStatus: 'paid' });
  });

  it('refunds move a completed sale to partially_refunded, then refunded', () => {
    const ctx = makeCtx();
    const done = completed(withLines(ctx, [['A', 1000n]]), ctx);
    throwsRule(
      () => applyRefund(placedOrder().o, { amountMinor: 1n, paymentRef: 'r' }, ctx),
      'ORDER_NOT_COMPLETED',
    );
    throwsRule(
      () => applyRefund(done, { amountMinor: 0n, paymentRef: 'r' }, ctx),
      'REFUND_AMOUNT_INVALID',
    );
    throwsRule(
      () => applyRefund(done, { amountMinor: 1001n, paymentRef: 'r' }, ctx),
      'REFUND_EXCEEDS_PAID',
    );
    const r1 = applyRefund(done, { amountMinor: 400n, paymentRef: 'r1', reason: 'faulty' }, ctx);
    expect(r1.state).toMatchObject({
      refundedMinor: 400n,
      paymentStatus: 'partially_refunded',
      status: 'completed',
    });
    expect(r1.events[0]).toMatchObject({
      kind: 'refund_applied',
      payload: { paymentStatus: 'partially_refunded' },
    });
    const r2 = applyRefund(r1.state, { amountMinor: 600n, paymentRef: 'r2' }, ctx);
    expect(r2.state.paymentStatus).toBe('refunded');
    throwsRule(
      () => applyRefund(r2.state, { amountMinor: 1n, paymentRef: 'r3' }, ctx),
      'NOTHING_TO_REFUND',
    );
  });

  it('reopen after a declined offline card payment: completed → open, money leaves the check', () => {
    const ctx = makeCtx();
    const done = completed(withLines(ctx, [['A', 1000n]]), ctx);
    throwsRule(
      () => reopenOffline(done, { reversedMinor: 5000n, reason: 'offline_payment_declined' }, ctx),
      'REVERSAL_INVALID',
    );
    const partial = reopenOffline(
      done,
      { reversedMinor: 300n, reason: 'offline_payment_declined', paymentRef: 'p1' },
      ctx,
    );
    expect(partial.state).toMatchObject({
      status: 'open',
      paymentStatus: 'partially_paid',
      paidMinor: 700n,
      reopenedReason: 'offline_payment_declined',
    });
    expect(partial.state.completedAt).toBeNull();
    expect(partial.state.checks[0]).toMatchObject({ status: 'open', closedAt: null });
    expect(partial.events[0]).toMatchObject({
      kind: 'reopened_offline_decline',
      fromStatus: 'completed',
      toStatus: 'open',
    });
    const full = reopenOffline(
      done,
      { reversedMinor: 1000n, reason: 'offline_payment_expired' },
      ctx,
    );
    expect(full.state).toMatchObject({ paymentStatus: 'unpaid', paidMinor: 0n });
    const after = markPaid(
      applyPayment(full.state, { amountMinor: 1000n, paymentRef: 'p9' }, ctx).state,
      ctx,
    );
    expect(after.state.status).toBe('completed');
    throwsRule(
      () =>
        reopenOffline(
          placedOrder().o,
          { reversedMinor: 1n, reason: 'offline_payment_declined' },
          ctx,
        ),
      'ILLEGAL_STATUS_TRANSITION',
    );
    const refunded = applyRefund(done, { amountMinor: 100n, paymentRef: 'r' }, ctx).state;
    throwsRule(
      () => reopenOffline(refunded, { reversedMinor: 1n, reason: 'offline_payment_declined' }, ctx),
      'ORDER_HAS_REFUNDS',
    );
  });

  it('every command bumps the order version by exactly one', () => {
    const ctx = makeCtx();
    let o = draft(ctx);
    const seen = [o.version];
    const step = (r: { state: OrderState }) => {
      o = r.state;
      seen.push(o.version);
    };
    step(add(o, ctx, 'A', 1000n));
    step(add(o, ctx, 'B', 500n));
    step(applyDiscount(o, { percent: '10', description: 'x', appliedBy: 'u' }, ctx));
    step(place(o, { orderNumber: 1 }, ctx));
    step(suspend(o, {}, ctx));
    step(resume(o, ctx));
    step(applyPayment(o, { amountMinor: o.totalMinor, paymentRef: 'p' }, ctx));
    step(markPaid(o, ctx));
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
