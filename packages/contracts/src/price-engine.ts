/**
 * Wire contracts for the pricing engine (slice F3): the order draft a client submits to
 * `POST /v1/pricing/preview` and the priced order it gets back. Money travels as integer strings
 * in minor units, quantities and percentages as decimal strings (docs/01-system-architecture.md
 * ADR 004); the engine in @pos/domain-core accepts these shapes directly, and `toPricedOrderDto`
 * turns its bigint output into the response shape.
 */
import type { priceEngine } from '@pos/domain-core';
import { z } from 'zod';

import { MinorAmountSchema, decimalString, isoInstant, uuid } from './common.js';
import { CurrencyCodeSchema, TimezoneSchema } from './tenancy.js';

const refId = z.string().min(1).max(64);
const nonNegativeMinor = MinorAmountSchema.refine(
  (v) => !v.startsWith('-'),
  'must not be negative',
);
const quantity = decimalString(4);
const percentString = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'percentage points, e.g. "12.5"');
const rateString = decimalString(6, 3);

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

export const DiscountAuthorizationSchema = z
  .object({
    /** User who authorised the discount or override. */
    authorizedBy: refId,
    /** identity.approval_requests id when the cashier's limit was exceeded. */
    approvalId: refId.optional(),
    /** pin, passkey, mfa_session, self … */
    method: z.string().min(1).max(32).optional(),
  })
  .strict();
export type DiscountAuthorizationDto = z.infer<typeof DiscountAuthorizationSchema>;

export const ManualDiscountSchema = z
  .object({
    id: refId,
    kind: z.enum(['percent', 'amount']),
    /** Percentage points ("12.5") for percent, integer minor units for amount. */
    value: z.string().regex(/^\d{1,18}(\.\d{1,4})?$/, 'non-negative decimal'),
    reason: z.string().max(200).optional(),
    authorization: DiscountAuthorizationSchema.optional(),
  })
  .strict()
  .refine((d) => (d.kind === 'amount' ? /^\d+$/.test(d.value) : Number(d.value) <= 100), {
    message: 'amount is an integer in minor units; percent is at most 100',
    path: ['value'],
  });
export type ManualDiscountDto = z.infer<typeof ManualDiscountSchema>;

export const PriceOverrideSchema = z
  .object({
    unitPriceMinor: nonNegativeMinor,
    taxInclusive: z.boolean().optional(),
    reason: z.string().max(200).optional(),
    authorization: DiscountAuthorizationSchema.optional(),
  })
  .strict();

export const DraftModifierSchema = z
  .object({
    id: refId,
    name: z.string().max(200).optional(),
    /** Per unit of the parent line; may be negative ("no cheese"). */
    priceMinor: MinorAmountSchema,
    quantity: quantity.optional(),
  })
  .strict();

export const DraftLineSchema = z
  .object({
    id: refId,
    variantId: uuid,
    itemId: uuid.optional(),
    categoryIds: z.array(uuid).max(50).optional(),
    tags: z.array(z.string().min(1).max(64)).max(50).optional(),
    quantity,
    /** catalog.item_variants.default_price_minor, from the caller's catalog snapshot. */
    defaultUnitPriceMinor: nonNegativeMinor.nullable().optional(),
    defaultTaxInclusive: z.boolean().optional(),
    taxClassId: uuid.nullable().optional(),
    priceOverride: PriceOverrideSchema.optional(),
    modifiers: z.array(DraftModifierSchema).max(50).optional(),
    manualDiscount: ManualDiscountSchema.optional(),
    promotionsExcluded: z.boolean().optional(),
  })
  .strict();
export type DraftLineDto = z.infer<typeof DraftLineSchema>;

export const DraftChargeSchema = z
  .object({
    id: refId,
    kind: z.enum(['service_charge', 'surcharge', 'delivery_fee']),
    name: z.string().max(200).optional(),
    amountMinor: nonNegativeMinor.optional(),
    percent: percentString.optional(),
    taxClassId: uuid.nullable().optional(),
    taxRate: rateString.optional(),
    taxInclusive: z.boolean().optional(),
  })
  .strict()
  .refine((c) => (c.amountMinor === undefined) !== (c.percent === undefined), {
    message: 'exactly one of amountMinor or percent',
    path: ['amountMinor'],
  });
export type DraftChargeDto = z.infer<typeof DraftChargeSchema>;

export const DraftTenderSchema = z
  .object({
    method: z.enum(['cash', 'card', 'gift_card', 'account', 'other']),
    amountMinor: nonNegativeMinor.optional(),
  })
  .strict();

export const DraftCustomerSchema = z
  .object({
    id: uuid.optional(),
    groupIds: z.array(uuid).max(50).optional(),
    taxExempt: z.boolean().optional(),
    taxExemptionReason: z.string().max(200).optional(),
    promotionUses: z.record(z.string(), z.number().int().min(0)).optional(),
  })
  .strict();

export const OrderDraftSchema = z
  .object({
    id: uuid.optional(),
    currency: CurrencyCodeSchema,
    lines: z.array(DraftLineSchema).max(500),
    manualDiscounts: z.array(ManualDiscountSchema).max(20).optional(),
    charges: z.array(DraftChargeSchema).max(20).optional(),
    couponCodes: z.array(z.string().min(1).max(64)).max(10).optional(),
    customer: DraftCustomerSchema.optional(),
    tenders: z.array(DraftTenderSchema).max(10).optional(),
  })
  .strict();
export type OrderDraftDto = z.infer<typeof OrderDraftSchema>;

// ---------------------------------------------------------------------------
// Preview request
// ---------------------------------------------------------------------------

/** Tax table for a preview until the real resolver is wired (Wave 2); absent = AU GST 10 % inclusive. */
export const PreviewTaxRuleSchema = z
  .object({
    id: refId,
    name: z.string().max(200).optional(),
    taxClassId: uuid.nullable(),
    rate: rateString,
    inclusiveDefault: z.boolean().optional(),
    compound: z.boolean().optional(),
    priority: z.number().int().optional(),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable()
      .optional(),
    region: z.string().max(64).nullable().optional(),
  })
  .strict();

export const PricingPreviewRequestSchema = z
  .object({
    /** The selling location: scopes promotions and price lists and the permission check. */
    locationId: uuid,
    channel: z.string().min(1).max(64).optional(),
    /** Business time; defaults to the server clock. */
    at: isoInstant.optional(),
    /** IANA zone of the location for promotion schedules; defaults to UTC. */
    timezone: TimezoneSchema.optional(),
    jurisdiction: z
      .object({
        country: z.string().regex(/^[A-Z]{2}$/),
        region: z.string().max(64).nullable().optional(),
      })
      .strict()
      .optional(),
    draft: OrderDraftSchema,
    taxRules: z.array(PreviewTaxRuleSchema).max(100).optional(),
    /** Every matching tax rule stacks as a component (state + city) instead of the best one. */
    stackTaxRules: z.boolean().optional(),
    /** null disables cash rounding; absent uses the currency's rule. */
    cashRounding: z
      .object({
        intervalMinor: z.number().int().min(1).max(100_000),
        mode: z.enum(['NEAREST_HALF_UP', 'NEAREST_HALF_DOWN', 'UP', 'DOWN']),
      })
      .strict()
      .nullable()
      .optional(),
    includeTrace: z.boolean().optional(),
  })
  .strict();
export type PricingPreviewRequest = z.infer<typeof PricingPreviewRequestSchema>;

// ---------------------------------------------------------------------------
// Priced order
// ---------------------------------------------------------------------------

const minor = MinorAmountSchema;

export const LineTaxSchema = z.object({
  ruleId: z.string().nullable(),
  name: z.string(),
  rate: z.string(),
  amountMinor: minor,
});

export const PricedOrderLineSchema = z.object({
  id: z.string(),
  variantId: z.string(),
  quantity: z.string(),
  baseUnitPriceMinor: minor,
  priceSource: z.object({
    kind: z.enum(['override', 'price_list', 'variant_default']),
    priceListId: z.string().optional(),
    entryId: z.string().optional(),
    authorizedBy: z.string().optional(),
    approvalId: z.string().optional(),
  }),
  modifiersUnitMinor: minor,
  unitPriceMinor: minor,
  grossMinor: minor,
  lineDiscountMinor: minor,
  promotionDiscountMinor: minor,
  orderDiscountMinor: minor,
  discounts: z.array(
    z.object({
      kind: z.enum(['manual', 'promotion', 'order']),
      ref: z.string(),
      amountMinor: minor,
    }),
  ),
  netMinor: minor,
  taxInclusive: z.boolean(),
  taxClassId: z.string().nullable(),
  taxes: z.array(LineTaxSchema),
  taxMinor: minor,
  taxExemptMinor: minor,
  totalMinor: minor,
});

export const PricedChargeSchema = z.object({
  id: z.string(),
  kind: z.enum(['service_charge', 'surcharge', 'delivery_fee']),
  name: z.string().optional(),
  amountMinor: minor,
  taxInclusive: z.boolean(),
  taxes: z.array(LineTaxSchema),
  taxMinor: minor,
  taxExemptMinor: minor,
  totalMinor: minor,
});

export const PromotionApplicationSchema = z.object({
  promotionId: z.string(),
  code: z.string().nullable(),
  name: z.string(),
  kind: z.string(),
  stackGroup: z.string().nullable(),
  couponId: z.string().nullable(),
  amountMinor: minor,
  applications: z.number().int(),
  lines: z.array(
    z.object({ lineId: z.string(), amountMinor: minor, units: z.number().int().optional() }),
  ),
});

export const PromotionSkipSchema = z.object({
  promotionId: z.string(),
  reason: z.enum([
    'inactive',
    'outside_validity',
    'outside_schedule',
    'out_of_scope',
    'conditions_not_met',
    'coupon_required',
    'coupon_invalid',
    'usage_limit',
    'budget_exhausted',
    'stack_group_taken',
    'excluded_by_promotion',
    'exclusive_conflict',
    'no_effect',
    'unsupported',
    'invalid_rules',
  ]),
  detail: z.string().optional(),
});

export const PricingTraceEntrySchema = z.object({
  seq: z.number().int().positive(),
  step: z.enum([
    'price_resolution',
    'modifier',
    'line_discount',
    'promotion',
    'promotion_skipped',
    'order_discount',
    'allocation',
    'tax',
    'tax_exemption',
    'charge',
    'cash_rounding',
  ]),
  ref: z.string(),
  amountMinor: minor,
  detail: z.string().optional(),
});

export const PricedOrderSchema = z.object({
  currency: CurrencyCodeSchema,
  at: z.string(),
  lines: z.array(PricedOrderLineSchema),
  charges: z.array(PricedChargeSchema),
  promotions: z.array(PromotionApplicationSchema),
  skippedPromotions: z.array(PromotionSkipSchema),
  orderDiscounts: z.array(
    z.object({
      id: z.string(),
      amountMinor: minor,
      authorization: DiscountAuthorizationSchema.optional(),
    }),
  ),
  subtotalMinor: minor,
  lineDiscountMinor: minor,
  promotionDiscountMinor: minor,
  orderDiscountMinor: minor,
  discountMinor: minor,
  netMinor: minor,
  taxMinor: minor,
  taxExemptMinor: minor,
  taxSummary: z.array(
    z.object({
      ruleId: z.string().nullable(),
      name: z.string(),
      rate: z.string(),
      taxableMinor: minor,
      taxMinor: minor,
    }),
  ),
  chargesMinor: minor,
  totalMinor: minor,
  roundingMinor: minor,
  amountDueMinor: minor,
  trace: z.array(PricingTraceEntrySchema),
});
export type PricedOrderDto = z.infer<typeof PricedOrderSchema>;

/** Deep copy with every bigint rendered as an integer string. */
export function bigintsToStrings<T>(value: T): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((v) => bigintsToStrings(v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, bigintsToStrings(v)]),
    );
  }
  return value;
}

/** Engine output (bigints) → wire shape; pass `includeTrace: false` to drop the trace. */
export function toPricedOrderDto(
  priced: priceEngine.PricedOrder,
  options: { includeTrace?: boolean } = {},
): PricedOrderDto {
  const dto = bigintsToStrings(priced) as PricedOrderDto;
  return options.includeTrace === false ? { ...dto, trace: [] } : dto;
}
