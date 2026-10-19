import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { priceOrder } from '../price-order.js';
import type { PromotionDefinition } from '../promotion-types.js';
import { FixedTaxRuleResolver, StaticTaxRuleResolver } from '../tax-resolver.js';
import type {
  DraftCharge,
  DraftLine,
  ManualDiscount,
  OrderDraft,
  PricingContext,
} from '../types.js';
import { ctx } from './helpers.js';

/**
 * Properties of docs/03-implementation-plan.md §5 F3: line totals plus charges equal the order
 * total, and discounts never exceed the subtotal, over randomly generated drafts that exercise
 * every pipeline step (lists, manual discounts, all six promotion kinds, charges, tax modes,
 * exemptions, tenders).
 */
const variants = ['v1', 'v2', 'v3', 'v4'];
const price = fc.integer({ min: 0, max: 50_000 });
const quantity = fc.oneof(
  fc.integer({ min: 0, max: 9 }).map(String),
  fc.integer({ min: 1, max: 99_999 }).map((n) => (n / 10_000).toFixed(4)),
);
const percent = fc.integer({ min: 0, max: 10_000 }).map((n) => (n / 100).toFixed(2));

const manualDiscount = (id: string): fc.Arbitrary<ManualDiscount> =>
  fc.oneof(
    fc.record({ id: fc.constant(id), kind: fc.constant('percent' as const), value: percent }),
    fc.record({
      id: fc.constant(id),
      kind: fc.constant('amount' as const),
      value: fc.integer({ min: 0, max: 80_000 }),
    }),
  );

const lineArb = (i: number): fc.Arbitrary<DraftLine> =>
  fc
    .record({
      variantId: fc.constantFrom(...variants),
      quantity,
      price,
      taxClassId: fc.constantFrom(null, 'free', 'excl'),
      tags: fc.subarray(['a', 'b', 'c']),
      discount: fc.option(manualDiscount(`d${i}`), { nil: undefined }),
      excluded: fc.boolean(),
      modifier: fc.option(fc.integer({ min: 0, max: 500 }), { nil: undefined }),
    })
    .map((r): DraftLine => ({
      id: `l${i}`,
      variantId: r.variantId,
      quantity: r.quantity,
      defaultUnitPriceMinor: r.price,
      taxClassId: r.taxClassId,
      tags: r.tags,
      ...(r.discount ? { manualDiscount: r.discount } : {}),
      ...(r.excluded ? { promotionsExcluded: true } : {}),
      ...(r.modifier !== undefined ? { modifiers: [{ id: `m${i}`, priceMinor: r.modifier }] } : {}),
    }));

const linesArb = fc
  .integer({ min: 0, max: 6 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => lineArb(i))));

const selector = fc.oneof(
  fc.constant({ all: true }),
  fc.subarray(['a', 'b', 'c'], { minLength: 1 }).map((tags) => ({ tags })),
  fc.subarray(variants, { minLength: 1 }).map((variantIds) => ({ variantIds })),
);

const promotionArb = (i: number): fc.Arbitrary<PromotionDefinition> => {
  const base = fc.record({
    priority: fc.integer({ min: 1, max: 5 }),
    stackGroup: fc.constantFrom(null, 'g1', 'g2'),
    isExclusive: fc.constant(false),
    targets: selector,
    budget: fc.option(fc.integer({ min: 0, max: 5_000 }), { nil: undefined }),
  });
  const effect = fc.oneof(
    percent.map((p) => ({ kind: 'percent_off' as const, percent: p })),
    fc
      .integer({ min: 0, max: 9_000 })
      .chain((a) =>
        fc
          .constantFrom('unit', 'line', 'order')
          .map((per) => ({ kind: 'amount_off' as const, amountMinor: a, per })),
      ),
    fc
      .integer({ min: 0, max: 20_000 })
      .map((p) => ({ kind: 'fixed_price' as const, priceMinor: p })),
    fc
      .record({
        buyQuantity: fc.integer({ min: 1, max: 3 }),
        getQuantity: fc.integer({ min: 1, max: 3 }),
        pct: percent,
      })
      .map((r) => ({
        kind: 'bogo' as const,
        buyQuantity: r.buyQuantity,
        getQuantity: r.getQuantity,
        percentOff: r.pct,
      })),
    fc
      .record({
        quantity: fc.integer({ min: 2, max: 4 }),
        priceMinor: fc.integer({ min: 0, max: 30_000 }),
      })
      .map((r) => ({
        kind: 'multibuy' as const,
        ...r,
      })),
    fc
      .array(fc.record({ min: fc.integer({ min: 0, max: 100_000 }), pct: percent }), {
        minLength: 1,
        maxLength: 3,
      })
      .map((tiers) => ({
        kind: 'threshold' as const,
        tiers: tiers.map((t) => ({ minSubtotalMinor: t.min, percent: t.pct })),
      })),
    fc.record({ price: fc.integer({ min: 0, max: 30_000 }) }).map((r) => ({
      kind: 'fixed_price' as const,
      priceMinor: r.price,
      bundle: [
        { targets: { tags: ['a'] }, quantity: 1 },
        { targets: { tags: ['b'] }, quantity: 1 },
      ],
    })),
  );
  return fc.tuple(base, effect).map(([b, e]) => ({
    id: `p${i}`,
    name: `p${i}`,
    kind: e.kind,
    rules: { version: 1, targets: b.targets, effect: e },
    priority: b.priority,
    stackGroup: b.stackGroup,
    validFrom: '2026-01-01T00:00:00Z',
    status: 'active',
    ...(b.budget !== undefined ? { budgetMinor: b.budget, spentMinor: 0 } : {}),
  }));
};

const promotionsArb = fc
  .integer({ min: 0, max: 4 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => promotionArb(i))));

const chargeArb = (i: number): fc.Arbitrary<DraftCharge> =>
  fc.oneof(
    fc.record({
      id: fc.constant(`c${i}`),
      kind: fc.constant('service_charge' as const),
      percent: percent.map((p) => String(Number(p) % 30)),
    }),
    fc.record({
      id: fc.constant(`c${i}`),
      kind: fc.constant('surcharge' as const),
      amountMinor: fc.integer({ min: 0, max: 2_000 }),
    }),
  );

const draftArb: fc.Arbitrary<OrderDraft> = fc
  .record({
    lines: linesArb,
    orderDiscounts: fc
      .array(manualDiscount('od'), { maxLength: 2 })
      .map((ds) => ds.map((d, i) => ({ ...d, id: `od${i}` }))),
    charges: fc
      .array(fc.nat(2), { maxLength: 2 })
      .chain((idx) => fc.tuple(...idx.map((_, i) => chargeArb(i)))),
    tender: fc.constantFrom('cash', 'card', 'none'),
    exempt: fc.boolean(),
  })
  .map((r): OrderDraft => ({
    currency: 'AUD',
    lines: r.lines,
    ...(r.orderDiscounts.length ? { manualDiscounts: r.orderDiscounts } : {}),
    ...(r.charges.length ? { charges: r.charges } : {}),
    ...(r.tender === 'none' ? {} : { tenders: [{ method: r.tender as 'cash' | 'card' }] }),
    ...(r.exempt ? { customer: { id: 'c', taxExempt: true } } : {}),
  }));

const resolver = new StaticTaxRuleResolver([
  { id: 'gst', name: 'GST', taxClassId: null, rate: '0.10' },
  { id: 'free', name: 'GST-free', taxClassId: 'free', rate: '0' },
  { id: 'excl', name: 'Excl', taxClassId: 'excl', rate: '0.0875', inclusiveDefault: false },
]);

const withPromotions = (promotions: readonly PromotionDefinition[]): PricingContext =>
  ctx({ promotions, taxResolver: resolver });

describe('pricing properties', () => {
  it('sum of line totals plus charges equals the order total; due = total + rounding', () => {
    fc.assert(
      fc.property(draftArb, promotionsArb, (draft, promotions) => {
        const out = priceOrder(draft, withPromotions(promotions));
        const lines = out.lines.reduce((a, l) => a + l.totalMinor, 0n);
        const charges = out.charges.reduce((a, c) => a + c.totalMinor, 0n);
        expect(out.totalMinor).toBe(lines + charges);
        expect(out.amountDueMinor).toBe(out.totalMinor + out.roundingMinor);
        for (const l of out.lines) {
          expect(l.totalMinor).toBe(
            l.taxInclusive ? l.netMinor - l.taxExemptMinor : l.netMinor + l.taxMinor,
          );
        }
      }),
      { numRuns: 400 },
    );
  });

  it('discounts never exceed the subtotal and no line goes negative', () => {
    fc.assert(
      fc.property(draftArb, promotionsArb, (draft, promotions) => {
        const out = priceOrder(draft, withPromotions(promotions));
        expect(out.discountMinor <= out.subtotalMinor).toBe(true);
        expect(out.discountMinor).toBe(
          out.lineDiscountMinor + out.promotionDiscountMinor + out.orderDiscountMinor,
        );
        expect(out.subtotalMinor - out.discountMinor).toBe(out.netMinor);
        for (const l of out.lines) {
          expect(l.netMinor >= 0n).toBe(true);
          expect(
            l.lineDiscountMinor + l.promotionDiscountMinor + l.orderDiscountMinor <= l.grossMinor,
          ).toBe(true);
          expect(l.taxMinor >= 0n).toBe(true);
        }
      }),
      { numRuns: 400 },
    );
  });

  it('allocated order discounts sum exactly to the discounts applied', () => {
    fc.assert(
      fc.property(draftArb, promotionsArb, (draft, promotions) => {
        const out = priceOrder(draft, withPromotions(promotions));
        expect(out.lines.reduce((a, l) => a + l.orderDiscountMinor, 0n)).toBe(
          out.orderDiscounts.reduce((a, d) => a + d.amountMinor, 0n),
        );
        expect(out.lines.reduce((a, l) => a + l.promotionDiscountMinor, 0n)).toBe(
          out.promotions.reduce((a, p) => a + p.amountMinor, 0n),
        );
        for (const p of out.promotions) {
          expect(p.lines.reduce((a, l) => a + l.amountMinor, 0n)).toBe(p.amountMinor);
        }
      }),
      { numRuns: 400 },
    );
  });

  it('is deterministic and independent of the order of promotions in the context', () => {
    fc.assert(
      fc.property(draftArb, promotionsArb, (draft, promotions) => {
        const a = priceOrder(draft, withPromotions(promotions));
        const b = priceOrder(draft, withPromotions(promotions));
        expect(b).toEqual(a);
        const reversed = priceOrder(draft, withPromotions([...promotions].reverse()));
        expect(reversed.totalMinor).toBe(a.totalMinor);
        expect(reversed.promotions.map((p) => p.promotionId)).toEqual(
          a.promotions.map((p) => p.promotionId),
        );
      }),
      { numRuns: 200 },
    );
  });

  it('cash rounding stays within 2c, lands on a 5c boundary, and never touches card orders', () => {
    fc.assert(
      fc.property(draftArb, (draft) => {
        const cash = priceOrder(
          { ...draft, tenders: [{ method: 'cash' }] },
          ctx({ taxResolver: resolver }),
        );
        expect(cash.roundingMinor >= -2n && cash.roundingMinor <= 2n).toBe(true);
        expect((cash.totalMinor + cash.roundingMinor) % 5n).toBe(0n);
        const card = priceOrder(
          { ...draft, tenders: [{ method: 'card' }] },
          ctx({ taxResolver: resolver }),
        );
        expect(card.roundingMinor).toBe(0n);
        expect(card.totalMinor).toBe(cash.totalMinor);
      }),
      { numRuns: 200 },
    );
  });

  it('inclusive/exclusive parity: the tax-exclusive net is the same either way', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 9_999 }), fc.integer({ min: 1, max: 9 })), {
          minLength: 1,
          maxLength: 5,
        }),
        (items) => {
          // price N exclusive with 10 % == price N × 1.1 inclusive, when N is a multiple of 10 (exact in minor units)
          const lines = items.map(([n, q], i): DraftLine => ({
            id: `l${i}`,
            variantId: 'v',
            quantity: String(q),
            defaultUnitPriceMinor: n * 10,
          }));
          const exclusive = priceOrder(
            { currency: 'AUD', lines },
            ctx({
              taxResolver: new FixedTaxRuleResolver({
                components: [{ ruleId: 'g', name: 'GST', rate: '0.10' }],
                inclusiveDefault: false,
              }),
            }),
          );
          const inclusive = priceOrder(
            {
              currency: 'AUD',
              lines: lines.map((l) => ({
                ...l,
                defaultUnitPriceMinor: (Number(l.defaultUnitPriceMinor) / 10) * 11,
              })),
            },
            ctx(),
          );
          expect(inclusive.totalMinor).toBe(exclusive.totalMinor);
          expect(inclusive.taxMinor).toBe(exclusive.taxMinor);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('tax-exempt orders collect no tax at all', () => {
    fc.assert(
      fc.property(draftArb, (draft) => {
        const out = priceOrder(
          { ...draft, customer: { id: 'c', taxExempt: true } },
          ctx({ taxResolver: resolver }),
        );
        expect(out.taxMinor).toBe(0n);
        expect(out.taxSummary.every((t) => t.taxMinor === 0n)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
