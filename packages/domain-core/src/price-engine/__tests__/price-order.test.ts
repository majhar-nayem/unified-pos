import { describe, expect, it } from 'vitest';

import { priceOrder } from '../price-order.js';
import { FixedTaxRuleResolver, StaticTaxRuleResolver } from '../tax-resolver.js';
import { ctx, line, order, promo } from './helpers.js';

describe('priceOrder pipeline', () => {
  it('defaults to AU GST 10 % inclusive and exposes the tax breakdown', () => {
    const out = priceOrder(order([line('a', 1, 1100)]), ctx());
    expect(out.totalMinor).toBe(1100n);
    expect(out.taxMinor).toBe(100n);
    expect(out.taxSummary).toEqual([
      { ruleId: 'au-gst', name: 'GST', rate: '0.10', taxableMinor: 1000n, taxMinor: 100n },
    ]);
    expect(out.lines[0]!.taxes).toEqual([
      { ruleId: 'au-gst', name: 'GST', rate: '0.10', amountMinor: 100n },
    ]);
    expect(out.currency).toBe('AUD');
    expect(out.at).toBe(ctx().at);
  });

  it('normalises the currency code and rejects unknown ones', () => {
    expect(priceOrder({ currency: 'aud', lines: [line('a', 1, 100)] }, ctx()).currency).toBe('AUD');
    expect(() => priceOrder({ currency: 'ZZZ', lines: [] }, ctx())).toThrow(/Unknown currency/);
    expect(() => priceOrder({ currency: 'AU', lines: [] }, ctx())).toThrow(TypeError);
  });

  it('rejects a bad business time', () => {
    expect(() => priceOrder(order([]), ctx({ at: 'yesterday' }))).toThrow(/context.at/);
  });

  it('passes class, jurisdiction, location and time to the tax resolver', () => {
    const seen: unknown[] = [];
    const resolver = {
      resolve(q: unknown) {
        seen.push(q);
        return { components: [], inclusiveDefault: true };
      },
    };
    priceOrder(
      order([line('a', 1, 100, { taxClassId: 'cls' })], {
        charges: [{ id: 'c', kind: 'surcharge', amountMinor: 10, taxClassId: 'chg' }],
      }),
      ctx({ taxResolver: resolver, jurisdiction: { country: 'NZ', region: 'AKL' } }),
    );
    expect(seen).toEqual([
      { taxClassId: 'cls', country: 'NZ', region: 'AKL', locationId: 'loc-syd', at: ctx().at },
      { taxClassId: 'chg', country: 'NZ', region: 'AKL', locationId: 'loc-syd', at: ctx().at },
    ]);
    seen.length = 0;
    priceOrder(order([line('a', 1, 100)]), ctx({ taxResolver: resolver, locationId: undefined }));
    expect(seen[0]).toEqual({
      taxClassId: null,
      country: 'AU',
      region: null,
      locationId: null,
      at: ctx().at,
    });
  });

  it('tax mode comes from the price source, then from the resolver', () => {
    const exclusive = new FixedTaxRuleResolver({
      components: [{ ruleId: 'r', name: 'T', rate: '0.10' }],
      inclusiveDefault: false,
    });
    const a = priceOrder(order([line('a', 1, 1000)]), ctx({ taxResolver: exclusive }));
    expect(a.totalMinor).toBe(1100n);
    const b = priceOrder(
      order([line('a', 1, 1000, { defaultTaxInclusive: true })]),
      ctx({ taxResolver: exclusive }),
    );
    expect(b.totalMinor).toBe(1000n);
    const c = priceOrder(
      order([line('a', 1, 1000, { priceOverride: { unitPriceMinor: 1000, taxInclusive: false } })]),
      ctx({
        taxResolver: new FixedTaxRuleResolver({
          components: [{ ruleId: 'r', name: 'T', rate: '0.10' }],
          inclusiveDefault: true,
        }),
      }),
    );
    expect(c.totalMinor).toBe(1100n);
  });

  it('modifier lines add per unit with decimal modifier quantities', () => {
    const out = priceOrder(
      order([
        line('a', 3, 1000, {
          modifiers: [
            { id: 'm1', priceMinor: 25 },
            { id: 'm2', priceMinor: 100, quantity: '0.5' },
          ],
        }),
      ]),
      ctx(),
    );
    expect(out.lines[0]!.modifiersUnitMinor).toBe(75n);
    expect(out.lines[0]!.unitPriceMinor).toBe(1075n);
    expect(out.subtotalMinor).toBe(3225n);
    expect(() =>
      priceOrder(order([line('a', 1, 10, { modifiers: [{ id: 'm', priceMinor: -20 }] })]), ctx()),
    ).toThrow(/negative/);
  });

  it('weighs decimal quantities and keeps them as strings', () => {
    const out = priceOrder(order([line('a', '1.2550', 599)]), ctx());
    expect(out.lines[0]!.quantity).toBe('1.2550');
    expect(out.subtotalMinor).toBe(752n);
  });

  it('manual discount traces authorisation and caps at the base', () => {
    const out = priceOrder(
      order([
        line('a', 1, 1000, {
          manualDiscount: {
            id: 'd',
            kind: 'percent',
            value: '10',
            reason: 'r',
            authorization: { authorizedBy: 'u', method: 'pin', approvalId: 'ap' },
          },
        }),
      ]),
      ctx(),
    );
    expect(out.trace.find((t) => t.step === 'line_discount')).toMatchObject({
      ref: 'a',
      amountMinor: -100n,
      detail: '10% reason: r authorized by u via pin approval ap',
    });
    const plain = priceOrder(
      order([line('a', 1, 1000, { manualDiscount: { id: 'd', kind: 'amount', value: 5 } })]),
      ctx(),
    );
    expect(plain.trace.find((t) => t.step === 'line_discount')!.detail).toBe('5 minor');
    const zeroBase = priceOrder(
      order([line('a', 1, 0, { manualDiscount: { id: 'd', kind: 'percent', value: '50' } })]),
      ctx(),
    );
    expect(zeroBase.lineDiscountMinor).toBe(0n);
    const exact = priceOrder(
      order([line('a', 1, 1000, { manualDiscount: { id: 'd', kind: 'amount', value: 1000 } })]),
      ctx(),
    );
    expect(exact.totalMinor).toBe(0n);
    const over = priceOrder(
      order([line('a', 1, 1000, { manualDiscount: { id: 'd', kind: 'amount', value: 1001 } })]),
      ctx(),
    );
    expect(over.lineDiscountMinor).toBe(1000n);
    const full = priceOrder(
      order([
        line('a', 1, 1000, { manualDiscount: { id: 'd', kind: 'percent', value: '100.00' } }),
      ]),
      ctx(),
    );
    expect(full.totalMinor).toBe(0n);
    expect(() =>
      priceOrder(
        order([line('a', 1, 1000, { manualDiscount: { id: 'd', kind: 'percent', value: '-1' } })]),
        ctx(),
      ),
    ).toThrow(/percent/);
  });

  it('order discounts allocate by largest remainder over the remaining amounts', () => {
    const out = priceOrder(
      order([line('a', 1, 333), line('b', 1, 333), line('c', 1, 334)], {
        manualDiscounts: [{ id: 'od', kind: 'amount', value: 100 }],
      }),
      ctx(),
    );
    expect(out.lines.map((l) => l.orderDiscountMinor)).toEqual([33n, 33n, 34n]);
    expect(out.lines.map((l) => l.discounts.map((d) => d.kind))).toEqual([
      ['order'],
      ['order'],
      ['order'],
    ]);
    expect(out.trace.filter((t) => t.step === 'allocation').map((t) => t.amountMinor)).toEqual([
      -33n,
      -33n,
      -34n,
    ]);
  });

  it('a zero-share line gets no allocation entry', () => {
    const out = priceOrder(
      order([line('a', 1, 1000), line('b', 1, 0)], {
        manualDiscounts: [{ id: 'od', kind: 'amount', value: 10 }],
      }),
      ctx(),
    );
    expect(out.lines[1]!.discounts).toEqual([]);
    expect(out.trace.filter((t) => t.step === 'allocation')).toHaveLength(1);
  });

  it('charges: percent of net, fixed, explicit tax, tax class, and validation', () => {
    const charge = (c: object, extra = {}) =>
      priceOrder(order([line('a', 1, 1000)], { charges: [c as never], ...extra }), ctx());
    expect(charge({ id: 'c', kind: 'service_charge', percent: '12.5' }).chargesMinor).toBe(125n);
    expect(charge({ id: 'c', kind: 'surcharge', amountMinor: 50 }).chargesMinor).toBe(50n);
    const explicit = charge({
      id: 'c',
      kind: 'delivery_fee',
      amountMinor: 500,
      taxRate: '0.1',
      taxInclusive: false,
    });
    expect(explicit.charges[0]).toMatchObject({
      taxMinor: 50n,
      totalMinor: 550n,
      taxInclusive: false,
    });
    expect('name' in explicit.charges[0]!).toBe(false);
    expect(
      charge({ id: 'c', kind: 'delivery_fee', name: 'Delivery', amountMinor: 500 }).charges[0]!
        .name,
    ).toBe('Delivery');
    expect(
      charge({ id: 'c', kind: 'surcharge', amountMinor: 110, taxRate: '0.1' }).charges[0],
    ).toMatchObject({ taxMinor: 10n, taxInclusive: true });
    expect(() => charge({ id: 'c', kind: 'surcharge', percent: '-1' })).toThrow(
      /must not be negative/,
    );
    expect(() => charge({ id: 'c', kind: 'surcharge', amountMinor: -1 })).toThrow(
      /must not be negative/,
    );
    expect(() => charge({ id: 'c', kind: 'surcharge', amountMinor: 1, percent: '1' })).toThrow(
      /either/,
    );
    expect(() => charge({ id: 'c', kind: 'surcharge' })).toThrow(/required/);
    // percent applies after discounts
    const afterDiscount = charge(
      { id: 'c', kind: 'service_charge', percent: '10' },
      { manualDiscounts: [{ id: 'od', kind: 'amount', value: 500 }] },
    );
    expect(afterDiscount.chargesMinor).toBe(50n);
  });

  it('tax-exempt customers: tax is removed from inclusive prices and never added when exclusive', () => {
    const inclusive = priceOrder(
      order([line('a', 1, 1100)], { customer: { taxExempt: true, taxExemptionReason: 'dip' } }),
      ctx(),
    );
    expect(inclusive).toMatchObject({ totalMinor: 1000n, taxMinor: 0n, taxExemptMinor: 100n });
    expect(inclusive.taxSummary).toEqual([]);
    expect(inclusive.lines[0]).toMatchObject({ netMinor: 1100n, totalMinor: 1000n, taxes: [] });
    expect(inclusive.trace.find((t) => t.step === 'tax_exemption')).toMatchObject({
      amountMinor: -100n,
      detail: 'dip',
    });
    const reasonless = priceOrder(
      order([line('a', 1, 1100)], { customer: { taxExempt: true } }),
      ctx(),
    );
    expect(reasonless.trace.find((t) => t.step === 'tax_exemption')!.detail).toBe(
      'customer exempt',
    );
    const notExempt = priceOrder(
      order([line('a', 1, 1100)], { customer: { taxExempt: false } }),
      ctx(),
    );
    expect(notExempt.taxMinor).toBe(100n);
    const zeroRate = priceOrder(
      order([line('a', 1, 1100, { taxClassId: 'free' })], { customer: { taxExempt: true } }),
      ctx({ taxResolver: new StaticTaxRuleResolver([{ id: 'f', taxClassId: 'free', rate: '0' }]) }),
    );
    expect(zeroRate.taxExemptMinor).toBe(0n);
    expect(zeroRate.trace.some((t) => t.step === 'tax_exemption')).toBe(false);
  });

  it('exempt customers also skip tax on charges', () => {
    const out = priceOrder(
      order([line('a', 1, 1100)], {
        customer: { taxExempt: true },
        charges: [{ id: 'c', kind: 'surcharge', amountMinor: 110 }],
      }),
      ctx(),
    );
    expect(out.charges[0]).toMatchObject({ taxMinor: 0n, taxExemptMinor: 10n, totalMinor: 100n });
    expect(out.taxExemptMinor).toBe(110n);
    expect(out.totalMinor).toBe(1100n);
    const exclusive = priceOrder(
      order([line('a', 1, 1000)], {
        customer: { taxExempt: true },
        charges: [
          { id: 'c', kind: 'surcharge', amountMinor: 100, taxRate: '0.1', taxInclusive: false },
        ],
      }),
      ctx({
        taxResolver: new FixedTaxRuleResolver({
          components: [{ ruleId: 'r', name: 'T', rate: '0.10' }],
          inclusiveDefault: false,
        }),
      }),
    );
    expect(exclusive.charges[0]).toMatchObject({
      taxMinor: 0n,
      totalMinor: 100n,
      taxExemptMinor: 10n,
    });
  });

  it('tax summary groups by rule, name and rate, sorted by rate', () => {
    const resolver = new StaticTaxRuleResolver([
      { id: 'std', name: 'GST', taxClassId: null, rate: '0.10' },
      { id: 'free', name: 'GST-free', taxClassId: 'free', rate: '0' },
    ]);
    const out = priceOrder(
      order([line('a', 1, 1100), line('b', 1, 2200), line('c', 1, 500, { taxClassId: 'free' })], {
        charges: [{ id: 'ch', kind: 'surcharge', amountMinor: 110 }],
      }),
      ctx({ taxResolver: resolver }),
    );
    expect(out.taxSummary).toEqual([
      { ruleId: 'free', name: 'GST-free', rate: '0', taxableMinor: 500n, taxMinor: 0n },
      {
        ruleId: 'std',
        name: 'GST',
        rate: '0.10',
        taxableMinor: 1000n + 2000n + 100n,
        taxMinor: 100n + 200n + 10n,
      },
    ]);
  });

  it('cash rounding: only the cash portion, rule overrides, explicit amounts', () => {
    const total = (t: object[], c = ctx()) =>
      priceOrder(order([line('a', 1, 2003)], { tenders: t as never }), c);
    expect(total([{ method: 'cash' }]).roundingMinor).toBe(2n);
    expect(total([{ method: 'card' }]).roundingMinor).toBe(0n);
    expect(total([]).roundingMinor).toBe(0n);
    expect(total([{ method: 'card', amountMinor: 1000 }, { method: 'cash' }]).roundingMinor).toBe(
      2n,
    );
    expect(total([{ method: 'card', amountMinor: 2003 }, { method: 'cash' }]).roundingMinor).toBe(
      0n,
    );
    expect(
      total([
        { method: 'cash', amountMinor: 1003 },
        { method: 'card', amountMinor: 1000 },
      ]).roundingMinor,
    ).toBe(2n);
    expect(total([{ method: 'cash' }], ctx({ cashRounding: null })).roundingMinor).toBe(0n);
    expect(
      total([{ method: 'cash' }], ctx({ cashRounding: { intervalMinor: 10, mode: 'DOWN' } }))
        .roundingMinor,
    ).toBe(-3n);
    expect(total([{ method: 'cash' }]).amountDueMinor).toBe(2005n);
    expect(() => total([{ method: 'card', amountMinor: 2004 }, { method: 'cash' }])).toThrow(
      /exceed/,
    );
    expect(() => total([{ method: 'card', amountMinor: -1 }, { method: 'cash' }])).toThrow(
      /negative/,
    );
    const trace = total([{ method: 'cash' }]).trace.at(-1)!;
    expect(trace).toMatchObject({
      step: 'cash_rounding',
      ref: 'tender',
      amountMinor: 2n,
      detail: 'cash 2003 → 2005',
    });
    expect(total([{ method: 'card' }]).trace.some((t) => t.step === 'cash_rounding')).toBe(false);
    const onGrid = priceOrder(
      order([line('a', 1, 2005)], { tenders: [{ method: 'cash' }] }),
      ctx(),
    );
    expect(onGrid.roundingMinor).toBe(0n);
    expect(onGrid.trace.at(-1)).toMatchObject({ step: 'cash_rounding', amountMinor: 0n });
  });

  it('trace sequence numbers run from 1 and promotions precede order discounts', () => {
    const out = priceOrder(
      order([line('a', 1, 1000)], {
        manualDiscounts: [{ id: 'od', kind: 'amount', value: 10 }],
        tenders: [{ method: 'cash' }],
      }),
      ctx({
        promotions: [
          promo('p', 'percent_off', {
            targets: { all: true },
            effect: { kind: 'percent_off', percent: '10' },
          }),
        ],
      }),
    );
    expect(out.trace.map((t) => t.seq)).toEqual(out.trace.map((_, i) => i + 1));
    const steps = out.trace.map((t) => t.step);
    expect(steps.indexOf('promotion')).toBeLessThan(steps.indexOf('order_discount'));
    expect(steps.indexOf('order_discount')).toBeLessThan(steps.indexOf('tax'));
    expect(steps.at(-1)).toBe('cash_rounding');
  });

  it('totals add up: subtotal − discounts = net; lines + charges = total; due = total + rounding', () => {
    const out = priceOrder(
      order(
        [
          line('a', 3, 333, { manualDiscount: { id: 'd', kind: 'percent', value: '15' } }),
          line('b', 2, 999),
        ],
        {
          manualDiscounts: [{ id: 'od', kind: 'amount', value: 77 }],
          charges: [{ id: 'c', kind: 'service_charge', percent: '10' }],
          tenders: [{ method: 'cash' }],
        },
      ),
      ctx({
        promotions: [
          promo('p', 'percent_off', {
            targets: { all: true },
            effect: { kind: 'percent_off', percent: '5' },
          }),
        ],
      }),
    );
    expect(out.subtotalMinor - out.discountMinor).toBe(out.netMinor);
    expect(out.discountMinor).toBe(
      out.lineDiscountMinor + out.promotionDiscountMinor + out.orderDiscountMinor,
    );
    const lines = out.lines.reduce((a, l) => a + l.totalMinor, 0n);
    const charges = out.charges.reduce((a, c) => a + c.totalMinor, 0n);
    expect(out.totalMinor).toBe(lines + charges);
    expect(out.chargesMinor).toBe(charges);
    expect(out.amountDueMinor).toBe(out.totalMinor + out.roundingMinor);
    expect(out.taxMinor).toBe(
      out.lines.reduce((a, l) => a + l.taxMinor, 0n) +
        out.charges.reduce((a, c) => a + c.taxMinor, 0n),
    );
  });
});
