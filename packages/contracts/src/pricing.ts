/**
 * Pricing DTOs for Phase 1 F2: tax classes (catalog.tax_classes) and tax rules
 * (pricing.tax_rules). Rates are data per tenant; nothing here assumes a rate.
 * Price lists and promotions arrive with F3.
 */
import { z } from 'zod';

import { CursorQuerySchema, decimalString, isoInstant, pageOf, uuid } from './common.js';
import { CalendarDateSchema } from './tenancy.js';

const code = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_]*$/, 'lowercase letters, digits and _ only');
const name = z.string().min(1).max(200);
const countryCode = z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2');

// ---------------------------------------------------------------------------
// Tax classes
// ---------------------------------------------------------------------------

export const TaxClassSchema = z.object({
  id: uuid,
  tenantId: uuid,
  code,
  name,
  version: z.number().int().positive(),
});
export type TaxClassDto = z.infer<typeof TaxClassSchema>;

export const CreateTaxClassSchema = z.object({ code, name });
export type CreateTaxClass = z.infer<typeof CreateTaxClassSchema>;
export const UpdateTaxClassSchema = z.object({ code, name }).partial();
export type UpdateTaxClass = z.infer<typeof UpdateTaxClassSchema>;
export const TaxClassPageSchema = pageOf(TaxClassSchema);

// ---------------------------------------------------------------------------
// Tax rules
// ---------------------------------------------------------------------------

export const TAX_RULE_KINDS = ['vat_gst', 'sales_tax', 'excise', 'levy'] as const;
export const TaxRuleKindSchema = z.enum(TAX_RULE_KINDS);
/** Rate as a decimal fraction string: "0.100000" for 10 %. numeric(9,6). */
export const TaxRateSchema = decimalString(6, 3);

export const TaxRuleSchema = z.object({
  id: uuid,
  tenantId: uuid,
  name,
  jurisdictionCountry: countryCode,
  /** State/province; null = whole country. */
  jurisdictionRegion: z.string().max(64).nullable(),
  /** null = default rule for the jurisdiction when no class-specific rule applies. */
  taxClassId: uuid.nullable(),
  kind: TaxRuleKindSchema,
  rate: TaxRateSchema,
  inclusiveDefault: z.boolean(),
  compound: z.boolean(),
  /** Higher wins. */
  priority: z.number().int(),
  validFrom: CalendarDateSchema,
  /** Inclusive last day the rule applies; null = open-ended. */
  validTo: CalendarDateSchema.nullable(),
  version: z.number().int().positive(),
});
export type TaxRuleDto = z.infer<typeof TaxRuleSchema>;

export const CreateTaxRuleSchema = z.object({
  name,
  jurisdictionCountry: countryCode,
  jurisdictionRegion: z.string().max(64).nullable().optional(),
  taxClassId: uuid.nullable().optional(),
  kind: TaxRuleKindSchema,
  rate: TaxRateSchema,
  inclusiveDefault: z.boolean().optional(),
  compound: z.boolean().optional(),
  priority: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  validFrom: CalendarDateSchema,
  validTo: CalendarDateSchema.nullable().optional(),
});
export type CreateTaxRule = z.infer<typeof CreateTaxRuleSchema>;

export const UpdateTaxRuleSchema = z
  .object({
    name,
    jurisdictionCountry: countryCode,
    jurisdictionRegion: z.string().max(64).nullable(),
    taxClassId: uuid.nullable(),
    kind: TaxRuleKindSchema,
    rate: TaxRateSchema,
    inclusiveDefault: z.boolean(),
    compound: z.boolean(),
    priority: z.number().int().min(-1_000_000).max(1_000_000),
    validFrom: CalendarDateSchema,
    validTo: CalendarDateSchema.nullable(),
  })
  .partial();
export type UpdateTaxRule = z.infer<typeof UpdateTaxRuleSchema>;

export const TaxRuleListQuerySchema = CursorQuerySchema.extend({
  jurisdictionCountry: countryCode.optional(),
  taxClassId: uuid.optional(),
});
export type TaxRuleListQuery = z.infer<typeof TaxRuleListQuerySchema>;
export const TaxRulePageSchema = pageOf(TaxRuleSchema);

/** Which rule applies to (country, region, tax class) on a date; the resolver lives in @pos/domain-core. */
export const TaxResolveQuerySchema = z.object({
  country: countryCode,
  region: z.string().max(64).optional(),
  taxClassId: uuid.optional(),
  /** Calendar date in the location's time zone; defaults to today (UTC). */
  on: CalendarDateSchema.optional(),
});
export type TaxResolveQuery = z.infer<typeof TaxResolveQuerySchema>;

export const TaxResolutionSchema = z.object({
  query: z.object({
    country: countryCode,
    region: z.string().nullable(),
    taxClassId: uuid.nullable(),
    on: CalendarDateSchema,
  }),
  rule: TaxRuleSchema.nullable(),
  /** Effective rate and mode for the pricing pipeline; rate "0" and inclusive when no rule matches. */
  rate: TaxRateSchema,
  inclusive: z.boolean(),
  candidates: z.number().int().nonnegative(),
  resolvedAt: isoInstant,
});
export type TaxResolutionDto = z.infer<typeof TaxResolutionSchema>;
