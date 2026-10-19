import { describe, expect, it } from 'vitest';

import type { PromotionDefinition } from '../promotion-types.js';
import { comparePromotions, scopesReach, selectorMatches } from '../promotions.js';
import { priceOrder } from '../price-order.js';
import type { DraftLine } from '../types.js';
import { ctx, line, order, promo } from './helpers.js';

const all = { all: true } as const;
const price = (
  lines: DraftLine[],
  promotions: ReturnType<typeof promo>[],
  draftExtra = {},
  ctxExtra = {},
) => priceOrder(order(lines, draftExtra), ctx({ promotions, ...ctxExtra }));

describe('selectorMatches', () => {
  const l: DraftLine = {
    id: 'l',
    variantId: 'v1',
    itemId: 'i1',
    categoryIds: ['c1', 'c2'],
    tags: ['hot', 'new'],
    quantity: '1',
  };
  it('matches by variant, item, category, tag or all', () => {
    expect(selectorMatches({ variantIds: ['v1'] }, l)).toBe(true);
    expect(selectorMatches({ itemIds: ['i1'] }, l)).toBe(true);
    expect(selectorMatches({ categoryIds: ['c2'] }, l)).toBe(true);
    expect(selectorMatches({ tags: ['new'] }, l)).toBe(true);
    expect(selectorMatches(all, l)).toBe(true);
    expect(selectorMatches({}, l)).toBe(false);
    expect(
      selectorMatches(
        { variantIds: ['v2'], itemIds: ['i2'], categoryIds: ['c3'], tags: ['cold'] },
        l,
      ),
    ).toBe(false);
    expect(selectorMatches({ itemIds: ['i1'] }, { ...l, itemId: undefined })).toBe(false);
  });
  it('exclusions win over inclusions', () => {
    expect(selectorMatches({ all: true, excludeVariantIds: ['v1'] }, l)).toBe(false);
    expect(selectorMatches({ all: true, excludeItemIds: ['i1'] }, l)).toBe(false);
    expect(selectorMatches({ all: true, excludeCategoryIds: ['c1'] }, l)).toBe(false);
    expect(selectorMatches({ all: true, excludeTags: ['hot'] }, l)).toBe(false);
    expect(selectorMatches({ all: true, excludeVariantIds: ['other'] }, l)).toBe(true);
    expect(selectorMatches({ variantIds: ['v1'], excludeTags: ['hot'] }, l)).toBe(false);
  });
});

describe('scopesReach', () => {
  const p = (scopes: NonNullable<PromotionDefinition['scopes']>) =>
    promo(
      'p',
      'percent_off',
      { targets: all, effect: { kind: 'percent_off', percent: '1' } },
      { scopes },
    );
  const c = ctx();
  it('no scopes means tenant-wide', () => {
    expect(scopesReach(p([]), c)).toBe(true);
    expect(
      scopesReach(
        promo('p', 'percent_off', { targets: all, effect: { kind: 'percent_off', percent: '1' } }),
        c,
      ),
    ).toBe(true);
  });
  it('each kind matches on its own key', () => {
    expect(scopesReach(p([{ scopeKind: 'tenant' }]), c)).toBe(true);
    expect(scopesReach(p([{ scopeKind: 'location', scopeId: 'loc-syd' }]), c)).toBe(true);
    expect(scopesReach(p([{ scopeKind: 'location', scopeId: 'loc-x' }]), c)).toBe(false);
    expect(scopesReach(p([{ scopeKind: 'location' }]), c)).toBe(false);
    expect(scopesReach(p([{ scopeKind: 'org_unit', scopeId: 'ou-root' }]), c)).toBe(true);
    expect(scopesReach(p([{ scopeKind: 'org_unit', scopeId: 'ou-x' }]), c)).toBe(false);
    expect(scopesReach(p([{ scopeKind: 'org_unit' }]), c)).toBe(false);
    expect(scopesReach(p([{ scopeKind: 'channel', scopeValue: 'pos' }]), c)).toBe(true);
    expect(scopesReach(p([{ scopeKind: 'channel', scopeValue: 'online' }]), c)).toBe(false);
    expect(scopesReach(p([{ scopeKind: 'channel' }]), c)).toBe(false);
    expect(scopesReach(p([{ scopeKind: 'customer_group', scopeId: 'g' }]), c, ['g'])).toBe(true);
    expect(scopesReach(p([{ scopeKind: 'customer_group', scopeId: 'g' }]), c, ['h'])).toBe(false);
    expect(scopesReach(p([{ scopeKind: 'customer_group', scopeId: 'g' }]), c)).toBe(false);
    expect(scopesReach(p([{ scopeKind: 'customer_group' }]), c, ['g'])).toBe(false);
  });
  it('any value of a kind and every kind present must match', () => {
    expect(
      scopesReach(
        p([
          { scopeKind: 'location', scopeId: 'x' },
          { scopeKind: 'location', scopeId: 'loc-syd' },
        ]),
        c,
      ),
    ).toBe(true);
    expect(
      scopesReach(
        p([
          { scopeKind: 'location', scopeId: 'loc-syd' },
          { scopeKind: 'channel', scopeValue: 'online' },
        ]),
        c,
      ),
    ).toBe(false);
    expect(
      scopesReach(
        p([
          { scopeKind: 'location', scopeId: 'loc-syd' },
          { scopeKind: 'channel', scopeValue: 'pos' },
        ]),
        c,
      ),
    ).toBe(true);
  });
});

describe('comparePromotions', () => {
  const mk = (id: string, extra = {}) =>
    promo(
      id,
      'percent_off',
      { targets: all, effect: { kind: 'percent_off', percent: '1' } },
      extra,
    );
  it('priority, then createdAt, then id; default priority 100', () => {
    expect(comparePromotions(mk('a', { priority: 1 }), mk('b', { priority: 2 }))).toBeLessThan(0);
    expect(comparePromotions(mk('a'), mk('b', { priority: 99 }))).toBeGreaterThan(0);
    expect(
      comparePromotions(mk('a', { createdAt: '2026-02-01' }), mk('b', { createdAt: '2026-01-01' })),
    ).toBeGreaterThan(0);
    expect(
      comparePromotions(mk('a', { createdAt: '2026-01-01' }), mk('b', { createdAt: '2026-02-01' })),
    ).toBeLessThan(0);
    expect(comparePromotions(mk('a'), mk('b'))).toBeLessThan(0);
    expect(comparePromotions(mk('b'), mk('a'))).toBeGreaterThan(0);
    expect(comparePromotions(mk('a'), mk('a'))).toBe(0);
  });
});

describe('promotion effects', () => {
  it('records exactly which lines and amounts each promotion touched', () => {
    const out = price(
      [line('a', 2, 500, { categoryIds: ['d'] }), line('b', 1, 700)],
      [
        promo(
          'p',
          'percent_off',
          { targets: { categoryIds: ['d'] }, effect: { kind: 'percent_off', percent: '10' } },
          { code: 'D10' },
        ),
      ],
    );
    expect(out.promotions).toEqual([
      {
        promotionId: 'p',
        code: 'D10',
        name: 'p',
        kind: 'percent_off',
        stackGroup: null,
        couponId: null,
        amountMinor: 100n,
        applications: 1,
        lines: [{ lineId: 'a', amountMinor: 100n }],
      },
    ]);
    expect(out.lines[0]!.discounts).toEqual([{ kind: 'promotion', ref: 'p', amountMinor: 100n }]);
    expect(out.lines[1]!.discounts).toEqual([]);
  });

  it('percent_off cap scales line discounts by largest remainder', () => {
    const out = price(
      [line('a', 1, 700), line('b', 1, 300)],
      [
        promo('p', 'percent_off', {
          targets: all,
          effect: { kind: 'percent_off', percent: '50', maxAmountMinor: 333 },
        }),
      ],
    );
    expect(out.promotionDiscountMinor).toBe(333n);
    expect(out.lines.map((l) => l.promotionDiscountMinor)).toEqual([233n, 100n]);
    expect(() =>
      price(
        [line('a', 1, 100)],
        [
          promo('p', 'percent_off', {
            targets: all,
            effect: { kind: 'percent_off', percent: '120' },
          }),
        ],
      ),
    ).not.toThrow();
  });

  it('amount_off per=unit multiplies by quantity and never exceeds the line', () => {
    const out = price(
      [line('a', '2.5', 100)],
      [
        promo('p', 'amount_off', {
          targets: all,
          effect: { kind: 'amount_off', amountMinor: 30, per: 'unit' },
        }),
      ],
    );
    expect(out.promotionDiscountMinor).toBe(75n);
    const capped = price(
      [line('a', 2, 10)],
      [
        promo('p', 'amount_off', {
          targets: all,
          effect: { kind: 'amount_off', amountMinor: 30, per: 'unit' },
        }),
      ],
    );
    expect(capped.promotionDiscountMinor).toBe(20n);
    const perLine = price(
      [line('a', 2, 10)],
      [
        promo('p', 'amount_off', {
          targets: all,
          effect: { kind: 'amount_off', amountMinor: 30, per: 'line' },
        }),
      ],
    );
    expect(perLine.promotionDiscountMinor).toBe(20n);
  });

  it('fixed_price per unit only discounts above the price and counts applications per line', () => {
    const out = price(
      [line('a', 2, 700), line('b', 1, 400)],
      [
        promo('p', 'fixed_price', {
          targets: all,
          effect: { kind: 'fixed_price', priceMinor: 500 },
        }),
      ],
    );
    expect(out.promotions[0]!.applications).toBe(1);
    expect(out.promotionDiscountMinor).toBe(400n);
    const two = price(
      [line('a', 1, 700), line('b', 1, 800)],
      [
        promo('p', 'fixed_price', {
          targets: all,
          effect: { kind: 'fixed_price', priceMinor: 500 },
        }),
      ],
    );
    expect(two.promotions[0]!.applications).toBe(2);
  });

  it('bogo validates its quantities and supports percent-off and get pools', () => {
    const bad = (effect: object) =>
      price([line('a', 4, 100)], [promo('p', 'bogo', { targets: all, effect: effect as never })]);
    expect(
      bad({ kind: 'bogo', buyQuantity: 0, getQuantity: 1 }).skippedPromotions[0],
    ).toMatchObject({ reason: 'invalid_rules', detail: expect.stringContaining('buyQuantity') });
    expect(
      bad({ kind: 'bogo', buyQuantity: 1, getQuantity: 0 }).skippedPromotions[0],
    ).toMatchObject({ reason: 'invalid_rules', detail: expect.stringContaining('getQuantity') });
    expect(
      bad({ kind: 'bogo', buyQuantity: 1.5, getQuantity: 1 }).skippedPromotions[0]!.reason,
    ).toBe('invalid_rules');
    expect(
      bad({ kind: 'bogo', buyQuantity: 1, getQuantity: 1, percentOff: '50' })
        .promotionDiscountMinor,
    ).toBe(100n);
    expect(bad({ kind: 'bogo', buyQuantity: 2, getQuantity: 1 }).promotionDiscountMinor).toBe(100n);
    expect(bad({ kind: 'bogo', buyQuantity: 1, getQuantity: 2 }).promotionDiscountMinor).toBe(200n);
    // 2 get-units per set discounted at 50 %
    const out = price(
      [line('a', 3, 100)],
      [
        promo('p', 'bogo', {
          targets: all,
          effect: { kind: 'bogo', buyQuantity: 1, getQuantity: 2, percentOff: '50' },
        }),
      ],
    );
    expect(out.promotionDiscountMinor).toBe(100n);
    expect(out.promotions[0]!.lines[0]!.units).toBe(3);
  });

  it('bogo get pool: buy units never double as get units and sets are limited by the smaller side', () => {
    const rules = {
      targets: { variantIds: ['v-burger'] },
      effect: {
        kind: 'bogo',
        buyQuantity: 1,
        getQuantity: 1,
        getTargets: { variantIds: ['v-drink'] },
      },
    } as const;
    const lines = (b: number, d: number) => [
      line('burger', b, 1000, { variantId: 'v-burger' }),
      line('drink', d, 300, { variantId: 'v-drink' }),
    ];
    expect(price(lines(1, 1), [promo('p', 'bogo', rules)]).promotionDiscountMinor).toBe(300n);
    expect(price(lines(2, 1), [promo('p', 'bogo', rules)]).promotionDiscountMinor).toBe(300n);
    expect(price(lines(1, 3), [promo('p', 'bogo', rules)]).promotionDiscountMinor).toBe(300n);
    expect(price(lines(3, 3), [promo('p', 'bogo', rules)]).promotionDiscountMinor).toBe(900n);
    expect(
      price(lines(3, 3), [
        promo('p', 'bogo', { ...rules, effect: { ...rules.effect, maxApplications: 2 } }),
      ]).promotionDiscountMinor,
    ).toBe(600n);
    expect(price(lines(0, 3), [promo('p', 'bogo', rules)]).promotionDiscountMinor).toBe(0n);
    // 2 burgers buy → 1 drink get: needs 2 burgers per drink
    expect(
      price(lines(3, 3), [
        promo('p', 'bogo', { ...rules, effect: { ...rules.effect, buyQuantity: 2 } }),
      ]).promotionDiscountMinor,
    ).toBe(300n);
  });

  it('multibuy validates quantity, honours maxApplications and skips non-saving groups', () => {
    const mb = (quantity: number, priceMinor: number, extra = {}) =>
      promo('p', 'multibuy', {
        targets: all,
        effect: { kind: 'multibuy', quantity, priceMinor, ...extra },
      });
    expect(price([line('a', 3, 400)], [mb(0, 1000)]).skippedPromotions[0]!.reason).toBe(
      'invalid_rules',
    );
    expect(price([line('a', 3, 400)], [mb(2.5, 1000)]).skippedPromotions[0]!.reason).toBe(
      'invalid_rules',
    );
    expect(
      price([line('a', 6, 400)], [mb(3, 1000, { maxApplications: 1 })]).promotionDiscountMinor,
    ).toBe(200n);
    expect(price([line('a', 6, 400)], [mb(3, 1000)]).promotions[0]!.applications).toBe(2);
    expect(price([line('a', 3, 400)], [mb(3, 1200)]).promotionDiscountMinor).toBe(0n);
    expect(price([line('a', 2, 400)], [mb(3, 100)]).promotionDiscountMinor).toBe(0n);
    // whole units only: 2.9 units is two units
    expect(price([line('a', '5.9', 400)], [mb(3, 1000)]).promotions[0]!.applications).toBe(1);
  });

  it('bundles never consume a unit twice and respect maxBundles', () => {
    const bundle = (extra = {}) =>
      promo('p', 'fixed_price', {
        targets: all,
        effect: {
          kind: 'fixed_price',
          priceMinor: 1000,
          bundle: [
            { targets: { tags: ['main'] }, quantity: 1 },
            { targets: { tags: ['side'] }, quantity: 2 },
          ],
          ...extra,
        },
      });
    const lines = (m: number, s: number) => [
      line('m', m, 1000, { tags: ['main'] }),
      line('s', s, 300, { tags: ['side'] }),
    ];
    expect(price(lines(1, 2), [bundle()]).promotionDiscountMinor).toBe(600n);
    expect(price(lines(1, 1), [bundle()]).promotionDiscountMinor).toBe(0n);
    expect(price(lines(2, 4), [bundle()]).promotionDiscountMinor).toBe(1200n);
    expect(price(lines(2, 4), [bundle({ maxBundles: 1 })]).promotionDiscountMinor).toBe(600n);
    expect(price(lines(2, 3), [bundle()]).promotions[0]!.applications).toBe(1);
    // one line matching both components: 2 units cannot fill 3 slots
    const overlap = promo('p', 'fixed_price', {
      targets: all,
      effect: {
        kind: 'fixed_price',
        priceMinor: 100,
        bundle: [
          { targets: { tags: ['x'] }, quantity: 1 },
          { targets: { tags: ['x'] }, quantity: 2 },
        ],
      },
    });
    expect(price([line('a', 2, 500, { tags: ['x'] })], [overlap]).promotionDiscountMinor).toBe(0n);
    expect(price([line('a', 3, 500, { tags: ['x'] })], [overlap]).promotionDiscountMinor).toBe(
      1400n,
    );
    const empty = promo('p', 'fixed_price', {
      targets: all,
      effect: { kind: 'fixed_price', priceMinor: 1, bundle: [] },
    });
    expect(price([line('a', 1, 100)], [empty]).skippedPromotions[0]!.reason).toBe('invalid_rules');
    const zero = promo('p', 'bundle', {
      targets: all,
      effect: { kind: 'fixed_price', priceMinor: 1, bundle: [{ targets: all, quantity: 0 }] },
    });
    expect(price([line('a', 1, 100)], [zero]).skippedPromotions[0]!.reason).toBe('invalid_rules');
  });

  it('kind "bundle" is an alias of a fixed_price bundle; mismatched kinds are invalid', () => {
    const rules = {
      targets: all,
      effect: { kind: 'fixed_price', priceMinor: 100, bundle: [{ targets: all, quantity: 2 }] },
    } as const;
    expect(price([line('a', 2, 500)], [promo('p', 'bundle', rules)]).promotionDiscountMinor).toBe(
      900n,
    );
    const noBundle = promo('p', 'bundle', {
      targets: all,
      effect: { kind: 'fixed_price', priceMinor: 100 },
    });
    expect(price([line('a', 2, 500)], [noBundle]).skippedPromotions[0]!.reason).toBe(
      'invalid_rules',
    );
  });

  it('threshold validates tiers and picks the highest reached', () => {
    const th = (tiers: object[]) =>
      promo('p', 'threshold', {
        targets: all,
        effect: { kind: 'threshold', tiers: tiers as never },
      });
    expect(price([line('a', 1, 5000)], [th([])]).skippedPromotions[0]!.reason).toBe(
      'invalid_rules',
    );
    expect(
      price([line('a', 1, 5000)], [th([{ minSubtotalMinor: 1000 }])]).skippedPromotions[0]!.reason,
    ).toBe('invalid_rules');
    expect(
      price(
        [line('a', 1, 5000)],
        [
          th([
            { minSubtotalMinor: 1000, percent: '10' },
            { minSubtotalMinor: 4000, percent: '20' },
          ]),
        ],
      ).promotionDiscountMinor,
    ).toBe(1000n);
    expect(
      price(
        [line('a', 1, 5000)],
        [
          th([
            { minSubtotalMinor: 4000, percent: '20' },
            { minSubtotalMinor: 1000, percent: '10' },
          ]),
        ],
      ).promotionDiscountMinor,
    ).toBe(1000n);
    expect(
      price([line('a', 1, 5000)], [th([{ minSubtotalMinor: 1000, amountMinor: 250 }])])
        .promotionDiscountMinor,
    ).toBe(250n);
    expect(
      price([line('a', 1, 5000)], [th([{ minSubtotalMinor: 5001, percent: '10' }])])
        .promotionDiscountMinor,
    ).toBe(0n);
  });

  it('threshold uses the subtotal left after earlier promotions', () => {
    const out = price(
      [line('a', 1, 5000)],
      [
        promo(
          'first',
          'amount_off',
          { targets: all, effect: { kind: 'amount_off', amountMinor: 1500, per: 'order' } },
          { priority: 1 },
        ),
        promo(
          'th',
          'threshold',
          {
            targets: all,
            effect: { kind: 'threshold', tiers: [{ minSubtotalMinor: 4000, percent: '10' }] },
          },
          { priority: 2 },
        ),
      ],
    );
    expect(out.promotions.map((p) => p.promotionId)).toEqual(['first']);
    expect(out.skippedPromotions[0]).toEqual({ promotionId: 'th', reason: 'no_effect' });
  });

  it('min subtotal and min quantity boundaries are inclusive', () => {
    const cond = (conditions: object) =>
      promo('p', 'percent_off', {
        targets: all,
        conditions,
        effect: { kind: 'percent_off', percent: '10' },
      });
    expect(
      price([line('a', 1, 800)], [cond({ minSubtotalMinor: 800 })]).promotionDiscountMinor,
    ).toBe(80n);
    expect(
      price([line('a', 1, 799)], [cond({ minSubtotalMinor: 800 })]).promotionDiscountMinor,
    ).toBe(0n);
    expect(price([line('a', 3, 100)], [cond({ minQuantity: '3' })]).promotionDiscountMinor).toBe(
      30n,
    );
    expect(
      price([line('a', '2.9999', 100)], [cond({ minQuantity: '3' })]).promotionDiscountMinor,
    ).toBe(0n);
    expect(
      price([line('a', 2, 100), line('b', 1, 100)], [cond({ minQuantity: '3' })])
        .promotionDiscountMinor,
    ).toBe(30n);
  });

  it('requiresCustomer and customer group conditions', () => {
    const cond = (conditions: object) =>
      promo('p', 'percent_off', {
        targets: all,
        conditions,
        effect: { kind: 'percent_off', percent: '10' },
      });
    expect(
      price([line('a', 1, 100)], [cond({ requiresCustomer: true })]).skippedPromotions[0]!.detail,
    ).toBe('customer');
    expect(
      price([line('a', 1, 100)], [cond({ requiresCustomer: true })], { customer: { id: 'c' } })
        .promotionDiscountMinor,
    ).toBe(10n);
    expect(
      price([line('a', 1, 100)], [cond({ customerGroupIds: ['g'] })], {
        customer: { id: 'c', groupIds: ['h'] },
      }).skippedPromotions[0]!.detail,
    ).toBe('customer_group');
    expect(
      price([line('a', 1, 100)], [cond({ customerGroupIds: ['g', 'h'] })], {
        customer: { id: 'c', groupIds: ['h'] },
      }).promotionDiscountMinor,
    ).toBe(10n);
    expect(price([line('a', 1, 100)], [cond({ channels: [] })]).promotionDiscountMinor).toBe(10n);
    expect(
      price([line('a', 1, 100)], [cond({ channels: ['pos', 'online'] })]).promotionDiscountMinor,
    ).toBe(10n);
    expect(
      price([line('a', 1, 100)], [cond({ channels: ['pos'] })], {}, { channel: null })
        .skippedPromotions[0]!.detail,
    ).toBe('channel');
  });

  it('records a skipped promotion with no targets', () => {
    const out = price(
      [line('a', 1, 100)],
      [
        promo('p', 'percent_off', {
          targets: { tags: ['none'] },
          effect: { kind: 'percent_off', percent: '10' },
        }),
      ],
    );
    expect(out.skippedPromotions).toEqual([
      { promotionId: 'p', reason: 'conditions_not_met', detail: 'no_targets' },
    ]);
  });

  it('budget: spends what is left and distributes the cap by largest remainder', () => {
    const p = promo(
      'p',
      'percent_off',
      { targets: all, effect: { kind: 'percent_off', percent: '50' } },
      { budgetMinor: 100, spentMinor: 0 },
    );
    const out = price([line('a', 1, 200), line('b', 1, 100)], [p]);
    expect(out.promotionDiscountMinor).toBe(100n);
    expect(out.lines.map((l) => l.promotionDiscountMinor)).toEqual([67n, 33n]);
    const within = price([line('a', 1, 100)], [{ ...p, budgetMinor: 500 }]);
    expect(within.promotionDiscountMinor).toBe(50n);
    const unlimited = price([line('a', 1, 100)], [{ ...p, budgetMinor: null }]);
    expect(unlimited.promotionDiscountMinor).toBe(50n);
  });

  it('usage limits: boundaries', () => {
    const p = (extra: object) =>
      promo(
        'p',
        'percent_off',
        { targets: all, effect: { kind: 'percent_off', percent: '10' } },
        extra,
      );
    expect(
      price([line('a', 1, 100)], [p({ maxUsesTotal: 5, usesCount: 4 })]).promotionDiscountMinor,
    ).toBe(10n);
    expect(
      price([line('a', 1, 100)], [p({ maxUsesTotal: 5, usesCount: 5 })]).promotionDiscountMinor,
    ).toBe(0n);
    expect(price([line('a', 1, 100)], [p({ maxUsesTotal: 5 })]).promotionDiscountMinor).toBe(10n);
    expect(
      price([line('a', 1, 100)], [p({ maxUsesTotal: null, usesCount: 99 })]).promotionDiscountMinor,
    ).toBe(10n);
    expect(
      price([line('a', 1, 100)], [p({ maxUsesPerCustomer: 2 })], {
        customer: { id: 'c', promotionUses: { p: 1 } },
      }).promotionDiscountMinor,
    ).toBe(10n);
    expect(
      price([line('a', 1, 100)], [p({ maxUsesPerCustomer: 2 })], {
        customer: { id: 'c', promotionUses: { p: 2 } },
      }).promotionDiscountMinor,
    ).toBe(0n);
    expect(price([line('a', 1, 100)], [p({ maxUsesPerCustomer: 0 })]).promotionDiscountMinor).toBe(
      0n,
    );
    expect(
      price([line('a', 1, 100)], [p({ maxUsesPerCustomer: null })], {
        customer: { id: 'c', promotionUses: { p: 9 } },
      }).promotionDiscountMinor,
    ).toBe(10n);
  });

  it('validity: validFrom inclusive, validTo exclusive, bad dates are invalid rules', () => {
    const p = (extra: object) =>
      promo(
        'p',
        'percent_off',
        { targets: all, effect: { kind: 'percent_off', percent: '10' } },
        extra,
      );
    const go = (extra: object) => price([line('a', 1, 100)], [p(extra)]);
    expect(go({ validFrom: '2026-10-19T02:00:00Z' }).promotionDiscountMinor).toBe(10n);
    expect(go({ validFrom: '2026-10-19T02:00:01Z' }).skippedPromotions[0]!.reason).toBe(
      'outside_validity',
    );
    expect(go({ validTo: '2026-10-19T02:00:01Z' }).promotionDiscountMinor).toBe(10n);
    expect(go({ validTo: '2026-10-19T02:00:00Z' }).skippedPromotions[0]!.reason).toBe(
      'outside_validity',
    );
    expect(go({ validTo: null }).promotionDiscountMinor).toBe(10n);
    expect(go({ validFrom: 'garbage' }).skippedPromotions[0]).toEqual({
      promotionId: 'p',
      reason: 'invalid_rules',
      detail: 'validFrom',
    });
    expect(go({ validTo: 'garbage' }).skippedPromotions[0]).toEqual({
      promotionId: 'p',
      reason: 'invalid_rules',
      detail: 'validTo',
    });
    expect(go({ status: undefined }).promotionDiscountMinor).toBe(10n);
    for (const status of ['draft', 'scheduled', 'paused', 'ended', 'archived']) {
      expect(go({ status }).skippedPromotions[0]!.reason).toBe('inactive');
    }
  });

  it('invalid rule documents are skipped, not thrown', () => {
    const base = promo('p', 'percent_off', {
      targets: all,
      effect: { kind: 'percent_off', percent: '10' },
    });
    const go = (p: unknown) => price([line('a', 1, 100)], [p as never]);
    expect(go({ ...base, rules: { ...base.rules, version: 2 } }).skippedPromotions[0]!.reason).toBe(
      'invalid_rules',
    );
    expect(go({ ...base, rules: { version: 1, targets: all } }).skippedPromotions[0]!.reason).toBe(
      'invalid_rules',
    );
    expect(
      go({ ...base, rules: { version: 1, effect: base.rules.effect } }).skippedPromotions[0]!
        .reason,
    ).toBe('invalid_rules');
    expect(go({ ...base, rules: undefined }).skippedPromotions[0]!.reason).toBe('invalid_rules');
    expect(go({ ...base, kind: 'employee' }).skippedPromotions[0]).toMatchObject({
      reason: 'unsupported',
      detail: 'employee',
    });
    expect(
      go({ ...base, rules: { ...base.rules, effect: { kind: 'percent_off', percent: '101' } } })
        .skippedPromotions[0]!.reason,
    ).toBe('invalid_rules');
  });

  it('exclusive promotion stops evaluation and marks the rest skipped', () => {
    const out = price(
      [line('a', 1, 1000)],
      [
        promo(
          'x',
          'percent_off',
          { targets: all, effect: { kind: 'percent_off', percent: '10' } },
          { priority: 1, isExclusive: true },
        ),
        promo(
          'y',
          'percent_off',
          { targets: all, effect: { kind: 'percent_off', percent: '10' } },
          { priority: 2 },
        ),
        promo(
          'z',
          'percent_off',
          { targets: all, effect: { kind: 'percent_off', percent: '10' } },
          { priority: 3 },
        ),
      ],
    );
    expect(out.promotions.map((p) => p.promotionId)).toEqual(['x']);
    expect(out.skippedPromotions).toEqual([
      { promotionId: 'y', reason: 'exclusive_conflict' },
      { promotionId: 'z', reason: 'exclusive_conflict' },
    ]);
  });

  it('coupon selection: lowest id first, case and whitespace insensitive', () => {
    const p = promo(
      'cp',
      'percent_off',
      { targets: all, effect: { kind: 'percent_off', percent: '10' } },
      { requiresCoupon: true },
    );
    const coupons = [
      { id: 'b', promotionId: 'cp', code: 'SAVE', status: 'active' as const },
      { id: 'a', promotionId: 'cp', code: ' save ', status: 'active' as const },
    ];
    const out = priceOrder(
      order([line('a', 1, 100)], { couponCodes: ['Save'] }),
      ctx({ promotions: [p], coupons }),
    );
    expect(out.promotions[0]!.couponId).toBe('a');
    const none = priceOrder(
      order([line('a', 1, 100)], { couponCodes: [] }),
      ctx({ promotions: [p], coupons }),
    );
    expect(none.skippedPromotions[0]!.reason).toBe('coupon_required');
    const other = priceOrder(
      order([line('a', 1, 100)], { couponCodes: ['SAVE'] }),
      ctx({ promotions: [p], coupons: [{ id: 'z', promotionId: 'other', code: 'SAVE' }] }),
    );
    expect(other.skippedPromotions[0]!.reason).toBe('coupon_required');
    const used = priceOrder(
      order([line('a', 1, 100)], { couponCodes: ['SAVE'] }),
      ctx({
        promotions: [p],
        coupons: [{ id: 'a', promotionId: 'cp', code: 'SAVE', maxUses: 3, usesCount: 2 }],
      }),
    );
    expect(used.promotions).toHaveLength(1);
    const expired = priceOrder(
      order([line('a', 1, 100)], { couponCodes: ['SAVE'] }),
      ctx({
        promotions: [p],
        coupons: [{ id: 'a', promotionId: 'cp', code: 'SAVE', expiresAt: '2026-10-19T02:00:01Z' }],
      }),
    );
    expect(expired.promotions).toHaveLength(1);
    const justExpired = priceOrder(
      order([line('a', 1, 100)], { couponCodes: ['SAVE'] }),
      ctx({
        promotions: [p],
        coupons: [{ id: 'a', promotionId: 'cp', code: 'SAVE', expiresAt: '2026-10-19T02:00:00Z' }],
      }),
    );
    expect(justExpired.skippedPromotions[0]!.reason).toBe('coupon_invalid');
  });
});
