import type { RoundingMode } from '../money/decimal.js';
import type { MinorAmountInput } from '../money/money.js';
import type { PromotionDefinition, PromotionKind } from './promotion-types.js';
import type { TaxRuleResolver } from './tax-resolver.js';

/**
 * Inputs and outputs of the full pricing pipeline (docs/01-system-architecture.md §7.2), slice F3.
 *
 * `priceOrder(draft, context)` is the `PricingPort`: the order draft is what the cashier built,
 * the context is everything the engine needs that lives in configuration (price lists and
 * promotions in scope, tax resolution, business time). Both are plain data so the same call
 * runs on the server, in the POS build and from JSON golden files.
 *
 * Minor amounts accept bigint, number or integer string; quantities, rates and percentages are
 * decimal strings. Nothing here assumes a currency, a rate or a rounding interval.
 */

export type DecimalInput = string | number;

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

export type ManualDiscountKind = 'percent' | 'amount';

export interface DiscountAuthorization {
  /** User id of the person who authorised the discount (cashier or approver). */
  readonly authorizedBy: string;
  /** identity.approval_requests id when the discount exceeded the cashier's limit. */
  readonly approvalId?: string;
  /** How the authorisation was given (pin, passkey, mfa_session, self). */
  readonly method?: string;
}

export interface ManualDiscount {
  readonly id: string;
  readonly kind: ManualDiscountKind;
  /** Percentage points for `percent` ("12.5"); minor units for `amount`. */
  readonly value: DecimalInput;
  readonly reason?: string;
  readonly authorization?: DiscountAuthorization;
}

export interface PriceOverride {
  readonly unitPriceMinor: MinorAmountInput;
  /** true when the override amount includes tax; defaults to the resolved mode of the line. */
  readonly taxInclusive?: boolean;
  readonly reason?: string;
  readonly authorization?: DiscountAuthorization;
}

export interface DraftModifier {
  readonly id: string;
  readonly name?: string;
  /** Price delta per unit of the parent line, in the line's tax mode. May be negative. */
  readonly priceMinor: MinorAmountInput;
  /** Modifier quantity per unit of the parent line; default 1. */
  readonly quantity?: DecimalInput;
}

export interface DraftLine {
  readonly id: string;
  readonly variantId: string;
  readonly itemId?: string;
  /** Category ids the item belongs to (its category and ancestors) for promotion targeting. */
  readonly categoryIds?: readonly string[];
  readonly tags?: readonly string[];
  /** Decimal quantity (numeric(14,4)); "1" for units, "1.2550" for weighed items. */
  readonly quantity: DecimalInput;
  /** catalog.item_variants.default_price_minor: used when no price list prices the variant. */
  readonly defaultUnitPriceMinor?: MinorAmountInput | null;
  /** true when the default price includes tax; falls back to the resolved tax rule's mode. */
  readonly defaultTaxInclusive?: boolean;
  /** Tax class of the item (null: jurisdiction default). */
  readonly taxClassId?: string | null;
  /** Step 1: cashier price override with its authorisation. */
  readonly priceOverride?: PriceOverride;
  readonly modifiers?: readonly DraftModifier[];
  /** Step 2: line-level manual discount. */
  readonly manualDiscount?: ManualDiscount;
  /** Lines that never take promotions (gift cards, deposits). */
  readonly promotionsExcluded?: boolean;
}

export type ChargeKind = 'service_charge' | 'surcharge' | 'delivery_fee';

export interface DraftCharge {
  readonly id: string;
  readonly kind: ChargeKind;
  readonly name?: string;
  /** Fixed amount in minor units, or … */
  readonly amountMinor?: MinorAmountInput;
  /** … a percentage of the lines' net total (after every discount). */
  readonly percent?: DecimalInput;
  /** Tax class resolved through the TaxRuleResolver (null: jurisdiction default). */
  readonly taxClassId?: string | null;
  /** Explicit tax treatment instead of resolution (rate as a decimal fraction). */
  readonly taxRate?: DecimalInput;
  readonly taxInclusive?: boolean;
}

export type TenderMethod = 'cash' | 'card' | 'gift_card' | 'account' | 'other';

export interface DraftTender {
  readonly method: TenderMethod;
  /** Amount of a non-cash tender in a split payment; the cash tender takes the remainder. */
  readonly amountMinor?: MinorAmountInput;
}

export interface DraftCustomer {
  readonly id?: string;
  readonly groupIds?: readonly string[];
  /** Tax-exempt customer (exemption certificate on file). */
  readonly taxExempt?: boolean;
  readonly taxExemptionReason?: string;
  /** Prior uses of promotions by this customer, for max_uses_per_customer. */
  readonly promotionUses?: Readonly<Record<string, number>>;
}

export interface OrderDraft {
  readonly id?: string;
  readonly currency: string;
  readonly lines: readonly DraftLine[];
  /** Step 4: order-level manual discounts, allocated to lines. */
  readonly manualDiscounts?: readonly ManualDiscount[];
  readonly charges?: readonly DraftCharge[];
  /** Coupon codes presented by the customer. */
  readonly couponCodes?: readonly string[];
  readonly customer?: DraftCustomer;
  /** Tenders; cash rounding applies to the cash portion only. */
  readonly tenders?: readonly DraftTender[];
}

// ---------------------------------------------------------------------------
// Context (configuration in scope)
// ---------------------------------------------------------------------------

export type PriceListKind =
  'retail' | 'wholesale' | 'member' | 'channel' | 'clearance' | 'employee';
export type PriceListStatus = 'draft' | 'active' | 'archived';
export type PriceListScopeKind =
  'tenant' | 'org_unit' | 'location' | 'channel' | 'customer_group' | 'customer';

export interface PriceListEntry {
  readonly id: string;
  readonly variantId: string;
  readonly priceMinor: MinorAmountInput;
  /** Tiered pricing: the entry applies from this quantity. Default "1". */
  readonly minQuantity?: DecimalInput;
  /** ISO instants; null/absent = open. */
  readonly validFrom?: string | null;
  readonly validTo?: string | null;
}

export interface PriceListAssignment {
  readonly id?: string;
  readonly scopeKind: PriceListScopeKind;
  /** org unit, location, customer group or customer id. */
  readonly scopeId?: string | null;
  /** Channel name for scopeKind 'channel'. */
  readonly scopeValue?: string | null;
  /** Lower wins. Default 100. */
  readonly priority?: number;
}

export interface PriceListDefinition {
  readonly id: string;
  readonly name?: string;
  readonly currency: string;
  readonly kind?: PriceListKind;
  /** Whether entry prices include tax. */
  readonly taxInclusive: boolean;
  /** Lower wins. Default 100. */
  readonly priority?: number;
  readonly status?: PriceListStatus;
  readonly entries: readonly PriceListEntry[];
  readonly assignments: readonly PriceListAssignment[];
}

export interface CouponDefinition {
  readonly id: string;
  readonly promotionId: string;
  readonly code: string;
  readonly customerId?: string | null;
  readonly maxUses?: number;
  readonly usesCount?: number;
  /** ISO instant. */
  readonly expiresAt?: string | null;
  readonly status?: 'active' | 'redeemed' | 'expired' | 'void';
}

export interface CashRoundingOverride {
  readonly intervalMinor: number;
  readonly mode: 'NEAREST_HALF_UP' | 'NEAREST_HALF_DOWN' | 'UP' | 'DOWN';
}

export interface PricingContext {
  /** Business time of the sale (ISO instant). Schedules and validity windows are evaluated here. */
  readonly at: string;
  /** IANA zone of the location, for promotion schedules. Default UTC. */
  readonly timezone?: string;
  readonly locationId?: string | null;
  /** The location's org unit and its ancestors, nearest first. */
  readonly orgUnitPath?: readonly string[];
  readonly channel?: string | null;
  readonly priceLists?: readonly PriceListDefinition[];
  readonly promotions?: readonly PromotionDefinition[];
  /** Coupons matching the draft's coupon codes (looked up by the caller). */
  readonly coupons?: readonly CouponDefinition[];
  /** Tax rule resolution; defaults to the in-package AU GST stub (see tax-resolver.ts). */
  readonly taxResolver?: TaxRuleResolver;
  /** Country/region for tax resolution. */
  readonly jurisdiction?: { readonly country: string; readonly region?: string | null };
  /** Override the currency registry's cash rounding rule (tenant config); null disables rounding. */
  readonly cashRounding?: CashRoundingOverride | null;
  /** Rounding mode for tax and percentage arithmetic. Default HALF_UP. */
  readonly roundingMode?: RoundingMode;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type PriceSourceKind = 'override' | 'price_list' | 'variant_default';

export interface PriceSource {
  readonly kind: PriceSourceKind;
  readonly priceListId?: string;
  readonly entryId?: string;
  readonly authorizedBy?: string;
  readonly approvalId?: string;
}

export interface LineTax {
  readonly ruleId: string | null;
  readonly name: string;
  /** Decimal fraction string. */
  readonly rate: string;
  readonly amountMinor: bigint;
}

export type LineDiscountKind = 'manual' | 'promotion' | 'order';

export interface LineDiscountEntry {
  readonly kind: LineDiscountKind;
  /** Manual discount id, promotion id or order discount id. */
  readonly ref: string;
  readonly amountMinor: bigint;
}

export interface PricedOrderLine {
  readonly id: string;
  readonly variantId: string;
  readonly quantity: string;
  /** Resolved base unit price before modifiers. */
  readonly baseUnitPriceMinor: bigint;
  readonly priceSource: PriceSource;
  /** Σ modifier price × modifier quantity, per unit. */
  readonly modifiersUnitMinor: bigint;
  /** base + modifiers, per unit. */
  readonly unitPriceMinor: bigint;
  /** unit price × quantity. */
  readonly grossMinor: bigint;
  readonly lineDiscountMinor: bigint;
  readonly promotionDiscountMinor: bigint;
  readonly orderDiscountMinor: bigint;
  readonly discounts: readonly LineDiscountEntry[];
  /** gross − every discount. Includes tax when inclusive. */
  readonly netMinor: bigint;
  readonly taxInclusive: boolean;
  readonly taxClassId: string | null;
  readonly taxes: readonly LineTax[];
  readonly taxMinor: bigint;
  /** Tax forgone because the customer is tax-exempt (removed from the price when inclusive, never added when exclusive). */
  readonly taxExemptMinor: bigint;
  /** What the customer pays for this line. */
  readonly totalMinor: bigint;
}

export interface PricedCharge {
  readonly id: string;
  readonly kind: ChargeKind;
  readonly name?: string;
  readonly amountMinor: bigint;
  readonly taxInclusive: boolean;
  readonly taxes: readonly LineTax[];
  readonly taxMinor: bigint;
  readonly taxExemptMinor: bigint;
  readonly totalMinor: bigint;
}

export interface PromotionLineApplication {
  readonly lineId: string;
  readonly amountMinor: bigint;
  /** Units consumed by unit-based effects (bogo, multibuy, bundles). */
  readonly units?: number;
}

export interface PromotionApplication {
  readonly promotionId: string;
  readonly code: string | null;
  readonly name: string;
  readonly kind: PromotionKind;
  readonly stackGroup: string | null;
  readonly couponId: string | null;
  readonly amountMinor: bigint;
  /** How many times a repeatable effect fired (bundles, multibuy groups, bogo sets). */
  readonly applications: number;
  readonly lines: readonly PromotionLineApplication[];
}

export type PromotionSkipReason =
  | 'inactive'
  | 'outside_validity'
  | 'outside_schedule'
  | 'out_of_scope'
  | 'conditions_not_met'
  | 'coupon_required'
  | 'coupon_invalid'
  | 'usage_limit'
  | 'budget_exhausted'
  | 'stack_group_taken'
  | 'excluded_by_promotion'
  | 'exclusive_conflict'
  | 'no_effect'
  | 'unsupported'
  | 'invalid_rules';

export interface PromotionSkip {
  readonly promotionId: string;
  readonly reason: PromotionSkipReason;
  readonly detail?: string;
}

export interface AppliedOrderDiscount {
  readonly id: string;
  readonly amountMinor: bigint;
  readonly authorization?: DiscountAuthorization;
}

export interface TaxSummaryEntry {
  readonly ruleId: string | null;
  readonly name: string;
  readonly rate: string;
  /** Σ tax base (net excluding tax) across lines and charges. */
  readonly taxableMinor: bigint;
  readonly taxMinor: bigint;
}

export type PricingStep =
  | 'price_resolution'
  | 'modifier'
  | 'line_discount'
  | 'promotion'
  | 'promotion_skipped'
  | 'order_discount'
  | 'allocation'
  | 'tax'
  | 'tax_exemption'
  | 'charge'
  | 'cash_rounding';

export interface PricingTraceEntry {
  readonly seq: number;
  readonly step: PricingStep;
  /** Line id, promotion id, discount id, charge id, or "tender". */
  readonly ref: string;
  readonly amountMinor: bigint;
  readonly detail?: string;
}

export interface PricedOrder {
  readonly currency: string;
  readonly at: string;
  readonly lines: readonly PricedOrderLine[];
  readonly charges: readonly PricedCharge[];
  readonly promotions: readonly PromotionApplication[];
  readonly skippedPromotions: readonly PromotionSkip[];
  readonly orderDiscounts: readonly AppliedOrderDiscount[];
  /** Σ line gross. */
  readonly subtotalMinor: bigint;
  readonly lineDiscountMinor: bigint;
  readonly promotionDiscountMinor: bigint;
  readonly orderDiscountMinor: bigint;
  /** All discounts. */
  readonly discountMinor: bigint;
  /** Σ line net. */
  readonly netMinor: bigint;
  readonly taxMinor: bigint;
  readonly taxExemptMinor: bigint;
  readonly taxSummary: readonly TaxSummaryEntry[];
  readonly chargesMinor: bigint;
  /** Σ line total + Σ charge total: what is owed before cash rounding. */
  readonly totalMinor: bigint;
  /** Cash rounding delta on the cash tender. */
  readonly roundingMinor: bigint;
  /** totalMinor + roundingMinor. */
  readonly amountDueMinor: bigint;
  readonly trace: readonly PricingTraceEntry[];
}

/** The port other modules consume (docs/03-implementation-plan.md §15.1). */
export type PricingPort = (draft: OrderDraft, context: PricingContext) => PricedOrder;
