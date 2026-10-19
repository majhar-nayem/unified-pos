/**
 * Price list, promotion and coupon DTOs for Phase 1 slice F3 (docs/03-implementation-plan.md §5),
 * including the validated promotion rules DSL v1 stored in `pricing.promotions.rules` (ADR 018).
 * Enum values mirror the CHECK constraints in db/schema_part2.sql. Money travels as integer
 * strings in minor units; quantities, rates and percentages as decimal strings.
 */
import { z } from 'zod';

import {
  CursorQuerySchema,
  MinorAmountSchema,
  decimalString,
  isoInstant,
  pageOf,
  uuid,
} from './common.js';
import { CurrencyCodeSchema, TimeOfDaySchema } from './tenancy.js';

const name = z.string().min(1).max(200);
const code = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'letters, digits, _ . and - only');
const version = z.number().int().positive();
const priority = z.number().int().min(-1_000_000).max(1_000_000);
const percent = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'percentage points, e.g. "12.5"')
  .refine((v) => Number(v) <= 100, 'at most 100');
const nonNegativeMinor = MinorAmountSchema.refine(
  (v) => !v.startsWith('-'),
  'must not be negative',
);
const wholeCount = z.number().int().min(1).max(1000);

// ---------------------------------------------------------------------------
// Promotion rules DSL v1 (pricing.promotions.rules)
// ---------------------------------------------------------------------------

const idList = z.array(uuid).max(500);
const tagList = z.array(z.string().min(1).max(64)).max(100);

/** Which lines an effect targets; a line matches when `all` or any include list names it and no exclude list does. */
export const ItemSelectorSchema = z
  .object({
    all: z.boolean().optional(),
    variantIds: idList.optional(),
    itemIds: idList.optional(),
    categoryIds: idList.optional(),
    tags: tagList.optional(),
    excludeVariantIds: idList.optional(),
    excludeItemIds: idList.optional(),
    excludeCategoryIds: idList.optional(),
    excludeTags: tagList.optional(),
  })
  .strict();
export type ItemSelector = z.infer<typeof ItemSelectorSchema>;

export const PromotionConditionsSchema = z
  .object({
    channels: z.array(z.string().min(1).max(64)).max(20).optional(),
    customerGroupIds: idList.optional(),
    requiresCustomer: z.boolean().optional(),
    minSubtotalMinor: nonNegativeMinor.optional(),
    minQuantity: decimalString(4).optional(),
    allowWithManualDiscount: z.boolean().optional(),
    excludesPromotionIds: idList.optional(),
  })
  .strict();
export type PromotionConditions = z.infer<typeof PromotionConditionsSchema>;

export const BundleComponentSchema = z
  .object({ targets: ItemSelectorSchema, quantity: wholeCount })
  .strict();

export const ThresholdTierSchema = z
  .object({
    minSubtotalMinor: nonNegativeMinor,
    percent: percent.optional(),
    amountMinor: nonNegativeMinor.optional(),
  })
  .strict()
  .refine((t) => (t.percent === undefined) !== (t.amountMinor === undefined), {
    message: 'exactly one of percent or amountMinor',
  });

export const PromotionEffectSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('percent_off'),
      percent,
      maxAmountMinor: nonNegativeMinor.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('amount_off'),
      amountMinor: nonNegativeMinor,
      per: z.enum(['unit', 'line', 'order']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('fixed_price'),
      priceMinor: nonNegativeMinor,
      bundle: z.array(BundleComponentSchema).min(1).max(20).optional(),
      maxBundles: wholeCount.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('bogo'),
      buyQuantity: wholeCount,
      getQuantity: wholeCount,
      percentOff: percent.optional(),
      getTargets: ItemSelectorSchema.optional(),
      maxApplications: wholeCount.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('multibuy'),
      quantity: z.number().int().min(2).max(1000),
      priceMinor: nonNegativeMinor,
      maxApplications: wholeCount.optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal('threshold'), tiers: z.array(ThresholdTierSchema).min(1).max(20) })
    .strict(),
]);
export type PromotionEffect = z.infer<typeof PromotionEffectSchema>;

export const PromotionRulesSchema = z
  .object({
    version: z.literal(1),
    targets: ItemSelectorSchema,
    conditions: PromotionConditionsSchema.optional(),
    effect: PromotionEffectSchema,
  })
  .strict();
export type PromotionRules = z.infer<typeof PromotionRulesSchema>;

/** pricing.promotions.schedule: optional weekdays (ISO, 1 = Monday) and local time windows. */
export const PromotionScheduleSchema = z
  .object({
    daysOfWeek: z.array(z.number().int().min(1).max(7)).max(7).optional(),
    windows: z
      .array(z.object({ from: TimeOfDaySchema, to: TimeOfDaySchema }).strict())
      .max(10)
      .optional(),
  })
  .strict();
export type PromotionSchedule = z.infer<typeof PromotionScheduleSchema>;

/**
 * Domain events the pricing module emits through the outbox so device replicas refresh.
 * They must be added to EVENT_CATALOG by the integration lead (that file is shared).
 */
export const PRICING_EVENTS = [
  'pricing.price_list.changed',
  'pricing.promotion.changed',
  'pricing.coupon.changed',
] as const;
export type PricingEventName = (typeof PRICING_EVENTS)[number];

/** Legal promotion status moves; everything else is a 409. `archived` is terminal. */
export const PROMOTION_STATUS_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  draft: ['scheduled', 'active', 'archived'],
  scheduled: ['draft', 'active', 'paused', 'archived'],
  active: ['paused', 'ended', 'archived'],
  paused: ['active', 'ended', 'archived'],
  ended: ['archived'],
  archived: [],
};

// ---------------------------------------------------------------------------
// Price lists
// ---------------------------------------------------------------------------

export const PRICE_LIST_KINDS = [
  'retail',
  'wholesale',
  'member',
  'channel',
  'clearance',
  'employee',
] as const;
export const PRICE_LIST_STATUSES = ['draft', 'active', 'archived'] as const;
export const PRICE_LIST_SCOPE_KINDS = [
  'tenant',
  'org_unit',
  'location',
  'channel',
  'customer_group',
  'customer',
] as const;

export const PriceListSchema = z.object({
  id: uuid,
  tenantId: uuid,
  name,
  currency: CurrencyCodeSchema,
  kind: z.enum(PRICE_LIST_KINDS),
  taxInclusive: z.boolean(),
  priority: z.number().int(),
  status: z.enum(PRICE_LIST_STATUSES),
  version,
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
export type PriceListDto = z.infer<typeof PriceListSchema>;

export const CreatePriceListSchema = z.object({
  name,
  currency: CurrencyCodeSchema,
  kind: z.enum(PRICE_LIST_KINDS).optional(),
  taxInclusive: z.boolean().optional(),
  priority: priority.optional(),
  status: z.enum(PRICE_LIST_STATUSES).optional(),
});
export type CreatePriceList = z.infer<typeof CreatePriceListSchema>;

/** The currency is fixed at creation: entries are priced in it. */
export const UpdatePriceListSchema = z
  .object({
    name,
    kind: z.enum(PRICE_LIST_KINDS),
    taxInclusive: z.boolean(),
    priority,
    status: z.enum(PRICE_LIST_STATUSES),
  })
  .partial();
export type UpdatePriceList = z.infer<typeof UpdatePriceListSchema>;

export const PriceListListQuerySchema = CursorQuerySchema.extend({
  status: z.enum(PRICE_LIST_STATUSES).optional(),
  kind: z.enum(PRICE_LIST_KINDS).optional(),
});
export type PriceListListQuery = z.infer<typeof PriceListListQuerySchema>;
export const PriceListPageSchema = pageOf(PriceListSchema);

export const PriceListEntrySchema = z.object({
  id: uuid,
  tenantId: uuid,
  priceListId: uuid,
  variantId: uuid,
  priceMinor: MinorAmountSchema,
  minQuantity: decimalString(4),
  validFrom: isoInstant.nullable(),
  validTo: isoInstant.nullable(),
  /** Current version of the owning price list: entries have no version of their own, every write is conditioned on and bumps the list's. */
  priceListVersion: version,
});
export type PriceListEntryDto = z.infer<typeof PriceListEntrySchema>;

const entryBody = {
  variantId: uuid,
  priceMinor: nonNegativeMinor,
  minQuantity: decimalString(4)
    .refine((v) => Number(v) > 0, 'must be greater than zero')
    .optional(),
  validFrom: isoInstant.nullable().optional(),
  validTo: isoInstant.nullable().optional(),
};
const validWindowOk = (e: { validFrom?: string | null; validTo?: string | null }) =>
  !e.validFrom || !e.validTo || Date.parse(e.validFrom) < Date.parse(e.validTo);

export const CreatePriceListEntrySchema = z
  .object(entryBody)
  .refine(validWindowOk, { message: 'validFrom must be before validTo', path: ['validTo'] });
export type CreatePriceListEntry = z.infer<typeof CreatePriceListEntrySchema>;

/** Upsert a batch of entries (admin console grid, CSV import): unique on (variant, min quantity, validFrom). */
export const BulkPriceListEntriesSchema = z.object({
  entries: z.array(CreatePriceListEntrySchema).min(1).max(1000),
});
export type BulkPriceListEntries = z.infer<typeof BulkPriceListEntriesSchema>;

export const UpdatePriceListEntrySchema = z
  .object({
    priceMinor: nonNegativeMinor,
    validFrom: isoInstant.nullable(),
    validTo: isoInstant.nullable(),
  })
  .partial()
  .refine(validWindowOk, { message: 'validFrom must be before validTo', path: ['validTo'] });
export type UpdatePriceListEntry = z.infer<typeof UpdatePriceListEntrySchema>;

export const PriceListEntryListQuerySchema = CursorQuerySchema.extend({
  variantId: uuid.optional(),
});
export type PriceListEntryListQuery = z.infer<typeof PriceListEntryListQuerySchema>;
export const PriceListEntryPageSchema = pageOf(PriceListEntrySchema);

export const PriceListAssignmentSchema = z.object({
  id: uuid,
  tenantId: uuid,
  priceListId: uuid,
  scopeKind: z.enum(PRICE_LIST_SCOPE_KINDS),
  scopeId: uuid.nullable(),
  scopeValue: z.string().nullable(),
  priority: z.number().int(),
  /** Version of the owning price list after this write (see PriceListEntrySchema). */
  priceListVersion: version,
});
export type PriceListAssignmentDto = z.infer<typeof PriceListAssignmentSchema>;

/** `channel` uses scopeValue (the channel name); `tenant` has neither; every other kind needs scopeId. */
const scopeShape = (s: {
  scopeKind: string;
  scopeId?: string | null;
  scopeValue?: string | null;
}) => {
  if (s.scopeKind === 'tenant') return !s.scopeId && !s.scopeValue;
  if (s.scopeKind === 'channel') return !!s.scopeValue && !s.scopeId;
  return !!s.scopeId && !s.scopeValue;
};
const SCOPE_MESSAGE = 'tenant takes no target, channel takes scopeValue, other kinds take scopeId';

export const CreatePriceListAssignmentSchema = z
  .object({
    scopeKind: z.enum(PRICE_LIST_SCOPE_KINDS),
    scopeId: uuid.nullable().optional(),
    scopeValue: z.string().min(1).max(64).nullable().optional(),
    priority: priority.optional(),
  })
  .refine(scopeShape, { message: SCOPE_MESSAGE, path: ['scopeKind'] });
export type CreatePriceListAssignment = z.infer<typeof CreatePriceListAssignmentSchema>;

export const UpdatePriceListAssignmentSchema = z.object({ priority });
export type UpdatePriceListAssignment = z.infer<typeof UpdatePriceListAssignmentSchema>;
export const PriceListAssignmentPageSchema = pageOf(PriceListAssignmentSchema);

// ---------------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------------

export const PROMOTION_KINDS = [
  'percent_off',
  'amount_off',
  'fixed_price',
  'bogo',
  'multibuy',
  'bundle',
  'threshold',
  'loyalty_price',
  'employee',
] as const;
/** Kinds the v1 engine evaluates; the rest are reserved by the schema for later slices. */
export const EVALUATED_PROMOTION_KINDS = [
  'percent_off',
  'amount_off',
  'fixed_price',
  'bogo',
  'multibuy',
  'bundle',
  'threshold',
] as const;
export const PROMOTION_STATUSES = [
  'draft',
  'scheduled',
  'active',
  'paused',
  'ended',
  'archived',
] as const;
export const PROMOTION_SCOPE_KINDS = [
  'tenant',
  'org_unit',
  'location',
  'channel',
  'customer_group',
] as const;

/** The rules' effect must agree with the promotion kind (`bundle` is a fixed_price effect with components). */
export const promotionKindMatchesRules = (kind: string, rules: PromotionRules): boolean =>
  kind === 'bundle'
    ? rules.effect.kind === 'fixed_price' && rules.effect.bundle !== undefined
    : kind === rules.effect.kind;

const KIND_MESSAGE =
  'rules.effect.kind must match kind (bundle needs a fixed_price effect with a bundle)';

export const PromotionSchema = z.object({
  id: uuid,
  tenantId: uuid,
  code: code.nullable(),
  name,
  description: z.string().max(2000).nullable(),
  kind: z.enum(PROMOTION_KINDS),
  rules: PromotionRulesSchema,
  priority: z.number().int(),
  stackGroup: z.string().nullable(),
  isExclusive: z.boolean(),
  requiresCoupon: z.boolean(),
  maxUsesTotal: z.number().int().nullable(),
  maxUsesPerCustomer: z.number().int().nullable(),
  usesCount: z.number().int(),
  budgetMinor: MinorAmountSchema.nullable(),
  spentMinor: MinorAmountSchema,
  schedule: PromotionScheduleSchema,
  validFrom: isoInstant,
  validTo: isoInstant.nullable(),
  status: z.enum(PROMOTION_STATUSES),
  version,
  createdBy: uuid.nullable(),
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
export type PromotionDto = z.infer<typeof PromotionSchema>;

const promotionFields = {
  code: code.nullable(),
  name,
  description: z.string().max(2000).nullable(),
  kind: z.enum(EVALUATED_PROMOTION_KINDS),
  rules: PromotionRulesSchema,
  priority,
  stackGroup: z.string().min(1).max(64).nullable(),
  isExclusive: z.boolean(),
  requiresCoupon: z.boolean(),
  maxUsesTotal: z.number().int().min(1).nullable(),
  maxUsesPerCustomer: z.number().int().min(1).nullable(),
  budgetMinor: nonNegativeMinor.nullable(),
  schedule: PromotionScheduleSchema,
  validFrom: isoInstant,
  validTo: isoInstant.nullable(),
  status: z.enum(PROMOTION_STATUSES),
};

export const CreatePromotionSchema = z
  .object({
    ...promotionFields,
    code: promotionFields.code.optional(),
    description: promotionFields.description.optional(),
    priority: priority.optional(),
    stackGroup: promotionFields.stackGroup.optional(),
    isExclusive: z.boolean().optional(),
    requiresCoupon: z.boolean().optional(),
    maxUsesTotal: promotionFields.maxUsesTotal.optional(),
    maxUsesPerCustomer: promotionFields.maxUsesPerCustomer.optional(),
    budgetMinor: promotionFields.budgetMinor.optional(),
    schedule: PromotionScheduleSchema.optional(),
    validTo: isoInstant.nullable().optional(),
    status: z.enum(PROMOTION_STATUSES).optional(),
    scopes: z
      .array(z.lazy(() => CreatePromotionScopeSchema))
      .max(100)
      .optional(),
  })
  .refine((p) => promotionKindMatchesRules(p.kind, p.rules), {
    message: KIND_MESSAGE,
    path: ['rules', 'effect', 'kind'],
  })
  .refine((p) => !p.validTo || Date.parse(p.validFrom) < Date.parse(p.validTo), {
    message: 'validFrom must be before validTo',
    path: ['validTo'],
  });
export type CreatePromotion = z.infer<typeof CreatePromotionSchema>;

export const UpdatePromotionSchema = z
  .object(promotionFields)
  .partial()
  .refine((p) => !p.kind || !p.rules || promotionKindMatchesRules(p.kind, p.rules), {
    message: KIND_MESSAGE,
    path: ['rules', 'effect', 'kind'],
  })
  .refine((p) => !p.validFrom || !p.validTo || Date.parse(p.validFrom) < Date.parse(p.validTo), {
    message: 'validFrom must be before validTo',
    path: ['validTo'],
  });
export type UpdatePromotion = z.infer<typeof UpdatePromotionSchema>;

export const PromotionListQuerySchema = CursorQuerySchema.extend({
  status: z.enum(PROMOTION_STATUSES).optional(),
  kind: z.enum(PROMOTION_KINDS).optional(),
  /** Only promotions whose validity window contains this instant. */
  activeAt: isoInstant.optional(),
});
export type PromotionListQuery = z.infer<typeof PromotionListQuerySchema>;
export const PromotionPageSchema = pageOf(PromotionSchema);

export const PromotionScopeSchema = z.object({
  id: uuid,
  tenantId: uuid,
  promotionId: uuid,
  scopeKind: z.enum(PROMOTION_SCOPE_KINDS),
  scopeId: uuid.nullable(),
  scopeValue: z.string().nullable(),
  /** Version of the owning promotion after this write: scope writes are conditioned on and bump it. */
  promotionVersion: version,
});
export type PromotionScopeDto = z.infer<typeof PromotionScopeSchema>;

export const CreatePromotionScopeSchema = z
  .object({
    scopeKind: z.enum(PROMOTION_SCOPE_KINDS),
    scopeId: uuid.nullable().optional(),
    scopeValue: z.string().min(1).max(64).nullable().optional(),
  })
  .refine(scopeShape, { message: SCOPE_MESSAGE, path: ['scopeKind'] });
export type CreatePromotionScope = z.infer<typeof CreatePromotionScopeSchema>;
export const PromotionScopePageSchema = pageOf(PromotionScopeSchema);

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------

export const COUPON_STATUSES = ['active', 'redeemed', 'expired', 'void'] as const;

export const CouponSchema = z.object({
  id: uuid,
  tenantId: uuid,
  promotionId: uuid,
  code: z.string(),
  customerId: uuid.nullable(),
  maxUses: z.number().int(),
  usesCount: z.number().int(),
  expiresAt: isoInstant.nullable(),
  status: z.enum(COUPON_STATUSES),
  createdAt: isoInstant,
});
export type CouponDto = z.infer<typeof CouponSchema>;

export const CouponCodeSchema = z
  .string()
  .min(4)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'letters, digits, _ and - only');

export const CreateCouponSchema = z.object({
  code: CouponCodeSchema,
  customerId: uuid.nullable().optional(),
  maxUses: z.number().int().min(1).max(1_000_000).optional(),
  expiresAt: isoInstant.nullable().optional(),
});
export type CreateCoupon = z.infer<typeof CreateCouponSchema>;

/** Coupons carry no version column: updates only extend or tighten an active coupon, or void it. */
export const UpdateCouponSchema = z
  .object({
    maxUses: z.number().int().min(1).max(1_000_000),
    expiresAt: isoInstant.nullable(),
    status: z.literal('void'),
  })
  .partial();
export type UpdateCoupon = z.infer<typeof UpdateCouponSchema>;

export const CouponListQuerySchema = CursorQuerySchema.extend({
  promotionId: uuid.optional(),
  status: z.enum(COUPON_STATUSES).optional(),
  code: z.string().min(1).max(64).optional(),
});
export type CouponListQuery = z.infer<typeof CouponListQuerySchema>;
export const CouponPageSchema = pageOf(CouponSchema);
