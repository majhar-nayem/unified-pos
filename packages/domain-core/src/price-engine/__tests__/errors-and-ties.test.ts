import { describe, expect, it } from 'vitest';

import { parseDecimal } from '../../money/decimal.js';
import { priceOrder } from '../price-order.js';
import { pickEntry, rankPriceLists } from '../price-resolution.js';
import { StaticTaxRuleResolver } from '../tax-resolver.js';
import type { PriceListDefinition } from '../types.js';
import { ctx, line, order, promo } from './helpers.js';

const permutations = <T>(items: readonly T[]): T[][] =>
  items.length <= 1
    ? [[...items]]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
      );

describe('exact error messages', () => {
  const run =
    (d: Parameters<typeof priceOrder>[0], c = ctx()) =>
    () =>
      priceOrder(d, c);
  it('are specific enough to act on', () => {
    expect(run(order([line('a', 1, 10), line('a', 1, 10)]))).toThrow('Duplicate line id a');
    expect(run(order([line('a', -1, 10)]))).toThrow('Line a: quantity must not be negative');
    expect(
      run(
        order([line('a', 1, 10, { manualDiscount: { id: 'd', kind: 'percent', value: '101' } })]),
      ),
    ).toThrow('Discount d: percent must be between 0 and 100');
    expect(
      run(order([line('a', 1, 10, { manualDiscount: { id: 'd', kind: 'amount', value: -5 } })])),
    ).toThrow('Discount d: amount must not be negative');
    expect(run(order([line('a', 1, 10)], { charges: [{ id: 'c', kind: 'surcharge' }] }))).toThrow(
      'Charge c: amountMinor or percent is required',
    );
    expect(
      run(
        order([line('a', 1, 10)], {
          charges: [{ id: 'c', kind: 'surcharge', amountMinor: 1, percent: '1' }],
        }),
      ),
    ).toThrow('Charge c: specify either amountMinor or percent, not both');
    expect(
      run(order([line('a', 1, 10)], { charges: [{ id: 'c', kind: 'surcharge', percent: '-1' }] })),
    ).toThrow('Charge c: percent must not be negative');
    expect(
      run(
        order([line('a', 1, 10)], { charges: [{ id: 'c', kind: 'surcharge', amountMinor: -1 }] }),
      ),
    ).toThrow('Charge c: amount must not be negative');
    expect(run(order([line('a', 1, 10, { modifiers: [{ id: 'm', priceMinor: -11 }] })]))).toThrow(
      'Line a: unit price with modifiers is negative',
    );
    expect(
      run(
        order([line('a', 1, 10)], {
          tenders: [{ method: 'card', amountMinor: 11 }, { method: 'cash' }],
        }),
      ),
    ).toThrow('Non-cash tenders exceed the order total');
    expect(run(order([{ id: 'a', variantId: 'v9', quantity: '1' }]))).toThrow(
      'Line a: no price list prices variant v9 and it has no default price',
    );
    expect(run(order([line('a', 1, -1)]))).toThrow('Line a: default price must not be negative');
    expect(run(order([line('a', 1, 1, { priceOverride: { unitPriceMinor: -1 } })]))).toThrow(
      'Line a override: amount must not be negative',
    );
    expect(run(order([]), ctx({ at: 'bad' }))).toThrow('context.at must be an ISO instant');
  });

  it('invalid promotion rules are reported in the skip detail, not thrown', () => {
    const out = priceOrder(
      order([line('a', 4, 100)]),
      ctx({
        promotions: [
          promo('p', 'bogo', {
            targets: { all: true },
            effect: { kind: 'bogo', buyQuantity: 0, getQuantity: 1 },
          }),
        ],
      }),
    );
    expect(out.skippedPromotions).toEqual([
      { promotionId: 'p', reason: 'invalid_rules', detail: 'bogo: buyQuantity must be ≥ 1' },
    ]);
    const mismatch = priceOrder(
      order([line('a', 4, 100)]),
      ctx({
        promotions: [
          promo('p', 'percent_off', {
            targets: { all: true },
            effect: { kind: 'amount_off', amountMinor: 1, per: 'order' },
          }),
        ],
      }),
    );
    expect(mismatch.skippedPromotions[0]).toEqual({
      promotionId: 'p',
      reason: 'invalid_rules',
      detail: 'kind percent_off vs effect amount_off',
    });
    const noRules = priceOrder(
      order([line('a', 1, 1)]),
      ctx({
        promotions: [
          {
            ...promo('p', 'percent_off', {
              targets: { all: true },
              effect: { kind: 'percent_off', percent: '1' },
            }),
            rules: undefined as never,
          },
        ],
      }),
    );
    expect(noRules.skippedPromotions[0]).toEqual({
      promotionId: 'p',
      reason: 'invalid_rules',
      detail: 'rules.version',
    });
    expect(
      priceOrder(
        order([line('a', 1, 1)]),
        ctx({
          promotions: [
            promo('p', 'loyalty_price', {
              targets: { all: true },
              effect: { kind: 'percent_off', percent: '1' },
            }),
          ],
        }),
      ).skippedPromotions[0],
    ).toEqual({ promotionId: 'p', reason: 'unsupported', detail: 'loyalty_price' });
  });

  it('skip details name the reason precisely', () => {
    const base = {
      targets: { all: true },
      effect: { kind: 'percent_off', percent: '10' },
    } as const;
    const skip = (extra: object, d = order([line('a', 1, 100)]), c = {}) =>
      priceOrder(d, ctx({ promotions: [promo('p', 'percent_off', base, extra)], ...c }))
        .skippedPromotions[0];
    expect(
      skip({ stackGroup: 'g' }, order([line('a', 1, 100)]), {
        promotions: [
          promo('first', 'percent_off', base, { stackGroup: 'g', priority: 1 }),
          promo('p', 'percent_off', base, { stackGroup: 'g', priority: 2 }),
        ],
      }),
    ).toEqual({
      promotionId: 'p',
      reason: 'stack_group_taken',
      detail: 'g',
    });
    expect(skip({ maxUsesTotal: 1, usesCount: 1 })).toEqual({
      promotionId: 'p',
      reason: 'usage_limit',
      detail: 'total',
    });
    expect(
      skip(
        { maxUsesPerCustomer: 1 },
        order([line('a', 1, 100)], { customer: { id: 'c', promotionUses: { p: 1 } } }),
      ),
    ).toEqual({ promotionId: 'p', reason: 'usage_limit', detail: 'customer' });
    expect(skip({ budgetMinor: 5, spentMinor: 5 })).toEqual({
      promotionId: 'p',
      reason: 'budget_exhausted',
    });
    expect(skip({ validFrom: 'nope' })).toEqual({
      promotionId: 'p',
      reason: 'invalid_rules',
      detail: 'validFrom',
    });
  });
});

describe('deterministic tie-breaks regardless of input order', () => {
  it('tax resolver: equal rules resolve to the lowest id from every permutation', () => {
    const rules = [
      { id: 'c', taxClassId: null, rate: '0.30' },
      { id: 'a', taxClassId: null, rate: '0.10' },
      { id: 'b', taxClassId: null, rate: '0.20' },
    ];
    for (const p of permutations(rules)) {
      expect(
        new StaticTaxRuleResolver(p).resolve({ taxClassId: null, at: 'x' }).components[0]!.ruleId,
      ).toBe('a');
    }
    const stacked = new StaticTaxRuleResolver(rules, { stackMatches: true });
    expect(stacked.resolve({ taxClassId: null, at: 'x' }).components.map((c) => c.ruleId)).toEqual([
      'a',
      'b',
      'c',
    ]);
    for (const p of permutations(rules)) {
      expect(
        new StaticTaxRuleResolver(p, { stackMatches: true })
          .resolve({ taxClassId: null, at: 'x' })
          .components.map((c) => c.ruleId),
      ).toEqual(['a', 'b', 'c']);
    }
  });

  const list = (id: string, extra: Partial<PriceListDefinition> = {}): PriceListDefinition => ({
    id,
    currency: 'AUD',
    taxInclusive: true,
    entries: [],
    assignments: [{ scopeKind: 'tenant' }],
    ...extra,
  });

  it('price lists: equal candidates order by list id, then assignment id, in every permutation', () => {
    const lists = [list('c'), list('a'), list('b')];
    for (const p of permutations(lists)) {
      expect(
        rankPriceLists(ctx({ priceLists: p }), 'AUD', undefined).map((x) => x.list.id),
      ).toEqual(['a', 'b', 'c']);
    }
    const one = list('x', {
      assignments: [
        { id: 'z', scopeKind: 'tenant' },
        { id: 'm', scopeKind: 'tenant' },
        { id: 'a', scopeKind: 'tenant' },
      ],
    });
    for (const p of permutations(one.assignments)) {
      expect(
        rankPriceLists(ctx({ priceLists: [{ ...one, assignments: p }] }), 'AUD', undefined).map(
          (x) => x.assignment.id,
        ),
      ).toEqual(['a', 'm', 'z']);
    }
    // missing assignment ids sort as the empty string, before any id
    const mixed = list('x', {
      assignments: [{ id: 'b', scopeKind: 'tenant' }, { scopeKind: 'tenant' }],
    });
    expect(
      rankPriceLists(ctx({ priceLists: [mixed] }), 'AUD', undefined).map((x) => x.assignment.id),
    ).toEqual([undefined, 'b']);
    const reversed = list('x', {
      assignments: [{ scopeKind: 'tenant' }, { id: 'b', scopeKind: 'tenant' }],
    });
    expect(
      rankPriceLists(ctx({ priceLists: [reversed] }), 'AUD', undefined).map((x) => x.assignment.id),
    ).toEqual([undefined, 'b']);
  });

  it('entries: tie on tier and validFrom resolves to the lowest id from every permutation', () => {
    const entries = [
      { id: 'c', variantId: 'v', priceMinor: 3 },
      { id: 'a', variantId: 'v', priceMinor: 1 },
      { id: 'b', variantId: 'v', priceMinor: 2 },
    ];
    const at = new Date('2026-10-19T02:00:00Z');
    for (const p of permutations(entries)) {
      expect(pickEntry(list('l', { entries: p }), 'v', parseDecimal('1'), at)!.id).toBe('a');
    }
    const dated = [
      { id: 'x', variantId: 'v', priceMinor: 1, validFrom: '2026-02-01T00:00:00Z' },
      { id: 'y', variantId: 'v', priceMinor: 2, validFrom: '2026-03-01T00:00:00Z' },
      { id: 'z', variantId: 'v', priceMinor: 3 },
    ];
    for (const p of permutations(dated)) {
      expect(pickEntry(list('l', { entries: p }), 'v', parseDecimal('1'), at)!.id).toBe('y');
    }
    const sameDate = [
      { id: 'q', variantId: 'v', priceMinor: 1, validFrom: '2026-02-01T00:00:00Z' },
      { id: 'p', variantId: 'v', priceMinor: 2, validFrom: '2026-02-01T00:00:00Z' },
    ];
    for (const p of permutations(sameDate)) {
      expect(pickEntry(list('l', { entries: p }), 'v', parseDecimal('1'), at)!.id).toBe('p');
    }
    const tiers = [
      { id: 't1', variantId: 'v', priceMinor: 1, minQuantity: '1' },
      { id: 't5', variantId: 'v', priceMinor: 2, minQuantity: '5' },
    ];
    for (const p of permutations(tiers)) {
      expect(pickEntry(list('l', { entries: p }), 'v', parseDecimal('5'), at)!.id).toBe('t5');
      expect(pickEntry(list('l', { entries: p }), 'v', parseDecimal('4'), at)!.id).toBe('t1');
    }
  });

  it('tax summary order is by rate then name regardless of line order', () => {
    const resolver = new StaticTaxRuleResolver([
      { id: 'r1', name: 'B-tax', taxClassId: 'c1', rate: '0.05' },
      { id: 'r2', name: 'A-tax', taxClassId: 'c2', rate: '0.05' },
      { id: 'r3', name: 'Z-tax', taxClassId: 'c3', rate: '0.01' },
      { id: 'r4', name: 'Y-tax', taxClassId: 'c4', rate: '0.20' },
    ]);
    const lines = ['c1', 'c2', 'c3', 'c4'].map((cls) => line(cls, 1, 1000, { taxClassId: cls }));
    for (const p of permutations(lines)) {
      const out = priceOrder(order(p), ctx({ taxResolver: resolver }));
      expect(out.taxSummary.map((t) => t.name)).toEqual(['Z-tax', 'A-tax', 'B-tax', 'Y-tax']);
    }
  });
});
