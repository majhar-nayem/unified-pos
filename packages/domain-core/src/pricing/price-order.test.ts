import { describe, expect, it } from 'vitest';

import { parseDecimal } from '../money/decimal.js';
import { computeTax, priceOrder } from './price-order.js';
import type { PriceOrderInput } from './types.js';

describe('computeTax', () => {
  it('extracts the GST component from an inclusive amount', () => {
    expect(computeTax(1100n, parseDecimal('0.10'), true, 'HALF_UP')).toBe(100n);
    expect(computeTax(900n, parseDecimal('0.10'), true, 'HALF_UP')).toBe(82n);
  });

  it('adds tax on top of an exclusive amount', () => {
    expect(computeTax(1000n, parseDecimal('0.10'), false, 'HALF_UP')).toBe(100n);
    expect(computeTax(5997n, parseDecimal('0.08875'), false, 'HALF_UP')).toBe(532n);
  });

  it('is zero for zero-rated and rejects negative rates', () => {
    expect(computeTax(1000n, parseDecimal('0'), true, 'HALF_UP')).toBe(0n);
    expect(() => computeTax(1000n, parseDecimal('-0.1'), true, 'HALF_UP')).toThrow(RangeError);
  });
});

describe('priceOrder invariants', () => {
  const basket: PriceOrderInput = {
    currency: 'AUD',
    lines: [
      { id: 'a', quantity: '3', unitPriceMinor: 333, taxRate: '0.10', taxInclusive: true },
      { id: 'b', quantity: '1', unitPriceMinor: 1, taxRate: '0.10', taxInclusive: true },
      {
        id: 'c',
        quantity: '0.5',
        unitPriceMinor: 999,
        taxRate: '0',
        taxInclusive: true,
        discount: { id: 'd', kind: 'amount', value: 50 },
      },
    ],
    orderDiscounts: [
      { id: 'od1', kind: 'percent', value: '7.5' },
      { id: 'od2', kind: 'amount', value: 20 },
    ],
    charges: [
      { id: 'sc', kind: 'service_charge', percent: '10', taxRate: '0.10', taxInclusive: true },
    ],
    tender: { method: 'cash' },
  };

  it('allocated order discounts sum exactly to the discount totals', () => {
    const out = priceOrder(basket);
    const allocated = out.lines.reduce((acc, l) => acc + l.orderDiscountMinor, 0n);
    expect(allocated).toBe(out.orderDiscountMinor);
    expect(out.discountMinor).toBe(out.lineDiscountMinor + out.orderDiscountMinor);
  });

  it('line totals plus charges equal the order total; amount due includes cash rounding', () => {
    const out = priceOrder(basket);
    const lineTotal = out.lines.reduce((acc, l) => acc + l.totalMinor, 0n);
    const chargeTotal = out.charges.reduce((acc, c) => acc + c.totalMinor, 0n);
    expect(out.totalMinor).toBe(lineTotal + chargeTotal);
    expect(out.amountDueMinor).toBe(out.totalMinor + out.roundingMinor);
    expect(out.amountDueMinor % 5n).toBe(0n);
  });

  it('is deterministic and idempotent on re-pricing', () => {
    expect(priceOrder(basket)).toEqual(priceOrder(basket));
  });

  it('does not round for card tenders', () => {
    const out = priceOrder({ ...basket, tender: { method: 'card' } });
    expect(out.roundingMinor).toBe(0n);
    expect(out.trace.some((t) => t.step === 'cash_rounding')).toBe(false);
  });

  it('caps discounts at the discountable base', () => {
    const out = priceOrder({
      currency: 'AUD',
      lines: [{ id: 'a', quantity: '1', unitPriceMinor: 100, taxRate: '0.10', taxInclusive: true }],
      orderDiscounts: [{ id: 'big', kind: 'amount', value: 500 }],
    });
    expect(out.orderDiscountMinor).toBe(100n);
    expect(out.netMinor).toBe(0n);
    expect(out.taxMinor).toBe(0n);
  });

  it('exclusive and inclusive modes agree on the tax-exclusive net', () => {
    const inclusive = priceOrder({
      currency: 'AUD',
      lines: [
        { id: 'a', quantity: '1', unitPriceMinor: 1100, taxRate: '0.10', taxInclusive: true },
      ],
    });
    const exclusive = priceOrder({
      currency: 'AUD',
      lines: [
        { id: 'a', quantity: '1', unitPriceMinor: 1000, taxRate: '0.10', taxInclusive: false },
      ],
    });
    expect(inclusive.totalMinor).toBe(exclusive.totalMinor);
    expect(inclusive.taxMinor).toBe(exclusive.taxMinor);
  });

  it('rejects unknown currencies, negative quantities and over-100% discounts', () => {
    const line = {
      id: 'a',
      quantity: '1',
      unitPriceMinor: 100,
      taxRate: '0.10',
      taxInclusive: true,
    };
    expect(() => priceOrder({ currency: 'ZZZ', lines: [line] })).toThrow(/Unknown currency/);
    expect(() => priceOrder({ currency: 'AUD', lines: [{ ...line, quantity: '-1' }] })).toThrow(
      RangeError,
    );
    expect(() =>
      priceOrder({
        currency: 'AUD',
        lines: [line],
        orderDiscounts: [{ id: 'x', kind: 'percent', value: '101' }],
      }),
    ).toThrow(RangeError);
    expect(() =>
      priceOrder({
        currency: 'AUD',
        lines: [line],
        charges: [{ id: 'c', kind: 'surcharge', taxRate: '0', taxInclusive: true }],
      }),
    ).toThrow(RangeError);
  });

  it('produces an ordered trace following the pipeline steps', () => {
    const steps = priceOrder(basket).trace.map((t) => t.step);
    const order = [
      'base_price',
      'line_discount',
      'order_discount',
      'allocation',
      'tax',
      'charge',
      'cash_rounding',
    ];
    const firstIndex = (step: string) => steps.indexOf(step as never);
    expect(firstIndex('base_price')).toBeLessThan(firstIndex('line_discount'));
    expect(firstIndex('line_discount')).toBeLessThan(firstIndex('order_discount'));
    expect(firstIndex('order_discount')).toBeLessThan(firstIndex('allocation'));
    expect(firstIndex('allocation')).toBeLessThan(firstIndex('tax'));
    expect(firstIndex('tax')).toBeLessThan(firstIndex('charge'));
    expect(steps.at(-1)).toBe('cash_rounding');
    expect(order.every((s) => steps.includes(s as never))).toBe(true);
  });
});
