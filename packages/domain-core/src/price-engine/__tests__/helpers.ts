import type { PromotionDefinition, PromotionRules } from '../promotion-types.js';
import type { DraftLine, OrderDraft, PricingContext } from '../types.js';

export const AT = '2026-10-19T02:00:00Z'; // Monday 13:00 Sydney (AEDT)

export const ctx = (extra: Partial<PricingContext> = {}): PricingContext => ({
  at: AT,
  timezone: 'Australia/Sydney',
  locationId: 'loc-syd',
  orgUnitPath: ['ou-nsw', 'ou-root'],
  channel: 'pos',
  ...extra,
});

export const line = (
  id: string,
  quantity: string | number,
  price: number,
  extra: Partial<DraftLine> = {},
): DraftLine => ({
  id,
  variantId: `v-${id}`,
  quantity,
  defaultUnitPriceMinor: price,
  ...extra,
});

export const order = (lines: DraftLine[], extra: Partial<OrderDraft> = {}): OrderDraft => ({
  currency: 'AUD',
  lines,
  ...extra,
});

export const promo = (
  id: string,
  kind: PromotionDefinition['kind'],
  rules: Omit<PromotionRules, 'version'>,
  extra: Partial<PromotionDefinition> = {},
): PromotionDefinition => ({
  id,
  name: id,
  kind,
  rules: { version: 1, ...rules } as PromotionRules,
  validFrom: '2026-01-01T00:00:00Z',
  status: 'active',
  ...extra,
});
