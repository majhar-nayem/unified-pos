import type { MinorAmountInput } from '../money/money.js';
import type { PromotionSchedule } from './schedule.js';
import type { DecimalInput } from './types.js';

/**
 * Promotion DSL v1 (docs/01-system-architecture.md ADR 018, docs/02-database-design.md §3.4):
 * `pricing.promotions.rules` jsonb, validated by `PromotionRulesSchema` in @pos/contracts and
 * evaluated here. Kinds supported in v1: percent_off, amount_off, fixed_price (per unit or as a
 * bundle / meal deal), bogo, multibuy, threshold. `bundle` is accepted as an alias of a
 * fixed_price bundle; loyalty_price and employee are reserved for later slices.
 */

export type PromotionKind =
  | 'percent_off'
  | 'amount_off'
  | 'fixed_price'
  | 'bogo'
  | 'multibuy'
  | 'bundle'
  | 'threshold'
  | 'loyalty_price'
  | 'employee';

export type PromotionStatus = 'draft' | 'scheduled' | 'active' | 'paused' | 'ended' | 'archived';

export type PromotionScopeKind = 'tenant' | 'org_unit' | 'location' | 'channel' | 'customer_group';

export interface PromotionScope {
  readonly scopeKind: PromotionScopeKind;
  readonly scopeId?: string | null;
  readonly scopeValue?: string | null;
}

/**
 * Which lines an effect targets. A line matches when `all` is set or any include list names
 * it, and no exclude list names it. No include list and no `all` matches nothing.
 */
export interface ItemSelector {
  readonly all?: boolean;
  readonly variantIds?: readonly string[];
  readonly itemIds?: readonly string[];
  readonly categoryIds?: readonly string[];
  readonly tags?: readonly string[];
  readonly excludeVariantIds?: readonly string[];
  readonly excludeItemIds?: readonly string[];
  readonly excludeCategoryIds?: readonly string[];
  readonly excludeTags?: readonly string[];
}

export interface PromotionConditions {
  /** Sales channels (pos, online, kiosk …) the promotion applies on. */
  readonly channels?: readonly string[];
  /** Customer must belong to one of these groups. */
  readonly customerGroupIds?: readonly string[];
  readonly requiresCustomer?: boolean;
  /** Targeted lines' remaining amount (after earlier steps) must reach this. */
  readonly minSubtotalMinor?: MinorAmountInput;
  /** Targeted lines' total quantity must reach this. */
  readonly minQuantity?: DecimalInput;
  /** Default true. false: lines carrying a manual discount are not targeted. */
  readonly allowWithManualDiscount?: boolean;
  /** Never applies together with these promotions, in either order. */
  readonly excludesPromotionIds?: readonly string[];
}

export interface BundleComponent {
  readonly targets: ItemSelector;
  /** Whole units of matching lines consumed per bundle. */
  readonly quantity: number;
}

export interface ThresholdTier {
  readonly minSubtotalMinor: MinorAmountInput;
  readonly percent?: DecimalInput;
  readonly amountMinor?: MinorAmountInput;
}

export type PromotionEffect =
  | {
      readonly kind: 'percent_off';
      readonly percent: DecimalInput;
      /** Cap on the total discount of one application. */
      readonly maxAmountMinor?: MinorAmountInput;
    }
  | {
      readonly kind: 'amount_off';
      readonly amountMinor: MinorAmountInput;
      /** unit: × quantity per line; line: once per targeted line; order: once, allocated. */
      readonly per: 'unit' | 'line' | 'order';
    }
  | {
      readonly kind: 'fixed_price';
      readonly priceMinor: MinorAmountInput;
      /** Meal deal: the components priced together; absent = per unit of every targeted line. */
      readonly bundle?: readonly BundleComponent[];
      readonly maxBundles?: number;
    }
  | {
      readonly kind: 'bogo';
      readonly buyQuantity: number;
      readonly getQuantity: number;
      /** Discount on the "get" units; default "100" (free). */
      readonly percentOff?: DecimalInput;
      /** Pool for the "get" units; default: the same targets, cheapest units discounted. */
      readonly getTargets?: ItemSelector;
      readonly maxApplications?: number;
    }
  | {
      readonly kind: 'multibuy';
      /** Units per group ("3 for $10"). */
      readonly quantity: number;
      readonly priceMinor: MinorAmountInput;
      readonly maxApplications?: number;
    }
  | {
      readonly kind: 'threshold';
      /** The highest tier whose minimum is reached applies, allocated over the targets. */
      readonly tiers: readonly ThresholdTier[];
    };

export interface PromotionRules {
  readonly version: 1;
  readonly targets: ItemSelector;
  readonly conditions?: PromotionConditions;
  readonly effect: PromotionEffect;
}

export interface PromotionDefinition {
  readonly id: string;
  readonly code?: string | null;
  readonly name: string;
  readonly kind: PromotionKind;
  readonly rules: PromotionRules;
  /** Lower first (docs/01 §7.2 step 3). Default 100. */
  readonly priority?: number;
  /** Promotions in the same group do not stack; the first by priority wins. */
  readonly stackGroup?: string | null;
  /** Applies alone: skipped when anything applied before it; stops evaluation after it. */
  readonly isExclusive?: boolean;
  readonly requiresCoupon?: boolean;
  readonly maxUsesTotal?: number | null;
  readonly maxUsesPerCustomer?: number | null;
  readonly usesCount?: number;
  readonly budgetMinor?: MinorAmountInput | null;
  readonly spentMinor?: MinorAmountInput;
  readonly schedule?: PromotionSchedule;
  /** ISO instant. */
  readonly validFrom: string;
  readonly validTo?: string | null;
  readonly status?: PromotionStatus;
  /** Tie-break after priority. */
  readonly createdAt?: string;
  readonly scopes?: readonly PromotionScope[];
}
