import { describe, expect, it } from 'vitest';

import {
  BulkPriceListEntriesSchema,
  CreateCouponSchema,
  CreatePriceListAssignmentSchema,
  CreatePriceListEntrySchema,
  CreatePriceListSchema,
  CreatePromotionSchema,
  CreatePromotionScopeSchema,
  PromotionRulesSchema,
  UpdateCouponSchema,
  UpdatePriceListSchema,
  UpdatePromotionSchema,
  promotionKindMatchesRules,
} from './promotions.js';

const id = '0198a000-0000-7000-8000-000000000001';
const id2 = '0198a000-0000-7000-8000-000000000002';
const rules = (effect: object, extra: object = {}) => ({
  version: 1,
  targets: { all: true },
  effect,
  ...extra,
});
const percentRules = rules({ kind: 'percent_off', percent: '10' });
const promotion = (over: object = {}) => ({
  name: 'Ten off',
  kind: 'percent_off',
  rules: percentRules,
  validFrom: '2026-10-01T00:00:00Z',
  ...over,
});

describe('PromotionRulesSchema (DSL v1)', () => {
  it('accepts every effect kind', () => {
    const effects = [
      { kind: 'percent_off', percent: '12.5', maxAmountMinor: '1000' },
      { kind: 'amount_off', amountMinor: '100', per: 'unit' },
      { kind: 'amount_off', amountMinor: '100', per: 'order' },
      { kind: 'fixed_price', priceMinor: '500' },
      {
        kind: 'fixed_price',
        priceMinor: '1800',
        bundle: [
          { targets: { variantIds: [id] }, quantity: 1 },
          { targets: { tags: ['drink'] }, quantity: 2 },
        ],
        maxBundles: 3,
      },
      {
        kind: 'bogo',
        buyQuantity: 1,
        getQuantity: 1,
        percentOff: '100',
        getTargets: { tags: ['drink'] },
        maxApplications: 2,
      },
      { kind: 'multibuy', quantity: 3, priceMinor: '1000' },
      {
        kind: 'threshold',
        tiers: [
          { minSubtotalMinor: '5000', percent: '10' },
          { minSubtotalMinor: '10000', amountMinor: '1500' },
        ],
      },
    ];
    for (const effect of effects)
      expect(PromotionRulesSchema.safeParse(rules(effect)).success, JSON.stringify(effect)).toBe(
        true,
      );
  });

  it('rejects unknown keys, bad versions and out-of-range values', () => {
    const bad = [
      { ...percentRules, version: 2 },
      { ...percentRules, extra: 1 },
      rules({ kind: 'percent_off', percent: '101' }),
      rules({ kind: 'percent_off', percent: '-1' }),
      rules({ kind: 'percent_off', percent: '10', surprise: true }),
      rules({ kind: 'amount_off', amountMinor: '-5', per: 'unit' }),
      rules({ kind: 'amount_off', amountMinor: '5', per: 'basket' }),
      rules({ kind: 'bogo', buyQuantity: 0, getQuantity: 1 }),
      rules({ kind: 'multibuy', quantity: 1, priceMinor: '100' }),
      rules({ kind: 'fixed_price', priceMinor: '1', bundle: [] }),
      rules({ kind: 'threshold', tiers: [] }),
      rules({ kind: 'threshold', tiers: [{ minSubtotalMinor: '1' }] }),
      rules({
        kind: 'threshold',
        tiers: [{ minSubtotalMinor: '1', percent: '1', amountMinor: '1' }],
      }),
      rules({ kind: 'unknown' }),
      rules({ kind: 'percent_off', percent: '10' }, { targets: { variantIds: ['not-a-uuid'] } }),
      { version: 1, effect: { kind: 'percent_off', percent: '10' } },
    ];
    for (const r of bad)
      expect(PromotionRulesSchema.safeParse(r).success, JSON.stringify(r)).toBe(false);
  });

  it('conditions are validated', () => {
    const ok = rules(
      { kind: 'percent_off', percent: '5' },
      {
        conditions: {
          channels: ['pos'],
          minSubtotalMinor: '800',
          minQuantity: '3',
          allowWithManualDiscount: false,
          excludesPromotionIds: [id],
        },
      },
    );
    expect(PromotionRulesSchema.safeParse(ok).success).toBe(true);
    const bad = rules(
      { kind: 'percent_off', percent: '5' },
      { conditions: { minSubtotalMinor: '-1' } },
    );
    expect(PromotionRulesSchema.safeParse(bad).success).toBe(false);
  });
});

describe('promotion create / update', () => {
  it('defaults are left to the server; a valid promotion parses', () => {
    const parsed = CreatePromotionSchema.parse(
      promotion({
        code: 'TEN',
        scopes: [{ scopeKind: 'location', scopeId: id }],
        schedule: { daysOfWeek: [1, 2], windows: [{ from: '16:00', to: '18:00' }] },
      }),
    );
    expect(parsed.code).toBe('TEN');
    expect(parsed.scopes).toHaveLength(1);
  });

  it('kind must agree with the effect; bundle needs a bundle effect', () => {
    expect(CreatePromotionSchema.safeParse(promotion({ kind: 'bogo' })).success).toBe(false);
    const bundle = rules({
      kind: 'fixed_price',
      priceMinor: '1800',
      bundle: [{ targets: { all: true }, quantity: 2 }],
    });
    expect(
      CreatePromotionSchema.safeParse(promotion({ kind: 'bundle', rules: bundle })).success,
    ).toBe(true);
    expect(
      CreatePromotionSchema.safeParse(
        promotion({ kind: 'bundle', rules: rules({ kind: 'fixed_price', priceMinor: '1' }) }),
      ).success,
    ).toBe(false);
    expect(
      CreatePromotionSchema.safeParse(promotion({ kind: 'fixed_price', rules: bundle })).success,
    ).toBe(true);
    expect(
      promotionKindMatchesRules('loyalty_price', PromotionRulesSchema.parse(percentRules)),
    ).toBe(false);
  });

  it('reserved kinds cannot be created yet', () => {
    expect(CreatePromotionSchema.safeParse(promotion({ kind: 'loyalty_price' })).success).toBe(
      false,
    );
    expect(CreatePromotionSchema.safeParse(promotion({ kind: 'employee' })).success).toBe(false);
  });

  it('validity window must be ordered', () => {
    expect(
      CreatePromotionSchema.safeParse(promotion({ validTo: '2026-12-01T00:00:00Z' })).success,
    ).toBe(true);
    expect(
      CreatePromotionSchema.safeParse(promotion({ validTo: '2026-10-01T00:00:00Z' })).success,
    ).toBe(false);
    expect(
      CreatePromotionSchema.safeParse(promotion({ validTo: '2026-09-01T00:00:00Z' })).success,
    ).toBe(false);
    expect(CreatePromotionSchema.safeParse(promotion({ validTo: null })).success).toBe(true);
  });

  it('limits and names are bounded', () => {
    expect(CreatePromotionSchema.safeParse(promotion({ name: '' })).success).toBe(false);
    expect(CreatePromotionSchema.safeParse(promotion({ maxUsesTotal: 0 })).success).toBe(false);
    expect(CreatePromotionSchema.safeParse(promotion({ budgetMinor: '-1' })).success).toBe(false);
    expect(CreatePromotionSchema.safeParse(promotion({ code: 'has space' })).success).toBe(false);
    expect(CreatePromotionSchema.safeParse(promotion({ status: 'live' })).success).toBe(false);
    expect(
      CreatePromotionSchema.safeParse(promotion({ schedule: { daysOfWeek: [0] } })).success,
    ).toBe(false);
    expect(
      CreatePromotionSchema.safeParse(
        promotion({ schedule: { windows: [{ from: '25:00', to: '26:00' }] } }),
      ).success,
    ).toBe(false);
  });

  it('update is partial but still cross-checks kind and rules', () => {
    expect(UpdatePromotionSchema.safeParse({ name: 'Renamed' }).success).toBe(true);
    expect(UpdatePromotionSchema.safeParse({}).success).toBe(true);
    expect(UpdatePromotionSchema.safeParse({ kind: 'bogo', rules: percentRules }).success).toBe(
      false,
    );
    expect(
      UpdatePromotionSchema.safeParse({ kind: 'percent_off', rules: percentRules }).success,
    ).toBe(true);
    expect(
      UpdatePromotionSchema.safeParse({
        validFrom: '2026-12-01T00:00:00Z',
        validTo: '2026-11-01T00:00:00Z',
      }).success,
    ).toBe(false);
  });
});

describe('scopes and assignments', () => {
  it('tenant takes no target, channel takes scopeValue, others take scopeId', () => {
    for (const ok of [
      { scopeKind: 'tenant' },
      { scopeKind: 'channel', scopeValue: 'online' },
      { scopeKind: 'location', scopeId: id },
      { scopeKind: 'org_unit', scopeId: id },
      { scopeKind: 'customer_group', scopeId: id },
    ])
      expect(CreatePromotionScopeSchema.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
    for (const bad of [
      { scopeKind: 'tenant', scopeId: id },
      { scopeKind: 'channel' },
      { scopeKind: 'channel', scopeId: id },
      { scopeKind: 'location' },
      { scopeKind: 'location', scopeValue: 'x' },
      { scopeKind: 'location', scopeId: id, scopeValue: 'x' },
      { scopeKind: 'customer', scopeId: id },
    ])
      expect(CreatePromotionScopeSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('price list assignments add the customer kind and a priority', () => {
    expect(
      CreatePriceListAssignmentSchema.safeParse({ scopeKind: 'customer', scopeId: id, priority: 5 })
        .success,
    ).toBe(true);
    expect(
      CreatePriceListAssignmentSchema.safeParse({ scopeKind: 'tenant', priority: 5 }).success,
    ).toBe(true);
    expect(CreatePriceListAssignmentSchema.safeParse({ scopeKind: 'customer' }).success).toBe(
      false,
    );
    expect(
      CreatePriceListAssignmentSchema.safeParse({ scopeKind: 'tenant', priority: 1.5 }).success,
    ).toBe(false);
  });
});

describe('price lists, entries and coupons', () => {
  it('price list create / update', () => {
    expect(
      CreatePriceListSchema.parse({
        name: 'Members',
        currency: 'AUD',
        kind: 'member',
        taxInclusive: true,
        priority: 10,
      }).currency,
    ).toBe('AUD');
    expect(CreatePriceListSchema.safeParse({ name: 'x', currency: 'aud' }).success).toBe(false);
    expect(
      CreatePriceListSchema.safeParse({ name: 'x', currency: 'AUD', kind: 'vip' }).success,
    ).toBe(false);
    expect(UpdatePriceListSchema.safeParse({ status: 'archived' }).success).toBe(true);
    expect(UpdatePriceListSchema.parse({ currency: 'USD', name: 'n' })).toEqual({ name: 'n' });
  });

  it('entries: price, tier and validity window', () => {
    expect(
      CreatePriceListEntrySchema.safeParse({
        variantId: id,
        priceMinor: '995',
        minQuantity: '6',
        validFrom: '2026-10-01T00:00:00Z',
        validTo: '2026-11-01T00:00:00Z',
      }).success,
    ).toBe(true);
    expect(CreatePriceListEntrySchema.safeParse({ variantId: id, priceMinor: '-1' }).success).toBe(
      false,
    );
    expect(
      CreatePriceListEntrySchema.safeParse({ variantId: id, priceMinor: '1', minQuantity: '0' })
        .success,
    ).toBe(false);
    expect(
      CreatePriceListEntrySchema.safeParse({
        variantId: id,
        priceMinor: '1',
        validFrom: '2026-11-01T00:00:00Z',
        validTo: '2026-10-01T00:00:00Z',
      }).success,
    ).toBe(false);
    expect(BulkPriceListEntriesSchema.safeParse({ entries: [] }).success).toBe(false);
    expect(
      BulkPriceListEntriesSchema.safeParse({
        entries: [
          { variantId: id, priceMinor: '1' },
          { variantId: id2, priceMinor: '2' },
        ],
      }).success,
    ).toBe(true);
  });

  it('coupons: code shape, uses and void-only updates', () => {
    expect(
      CreateCouponSchema.safeParse({
        code: 'SAVE-10',
        maxUses: 5,
        expiresAt: '2026-12-31T00:00:00Z',
        customerId: id,
      }).success,
    ).toBe(true);
    expect(CreateCouponSchema.safeParse({ code: 'abc' }).success).toBe(false);
    expect(CreateCouponSchema.safeParse({ code: 'has space' }).success).toBe(false);
    expect(CreateCouponSchema.safeParse({ code: 'SAVE10', maxUses: 0 }).success).toBe(false);
    expect(UpdateCouponSchema.safeParse({ status: 'void' }).success).toBe(true);
    expect(UpdateCouponSchema.safeParse({ status: 'active' }).success).toBe(false);
  });
});
