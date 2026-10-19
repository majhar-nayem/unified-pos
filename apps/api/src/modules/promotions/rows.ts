import type {
  CouponDto,
  PriceListAssignmentDto,
  PriceListDto,
  PriceListEntryDto,
  PromotionDto,
  PromotionScopeDto,
} from '@pos/contracts';

/** Row shapes (snake_case, as pg returns them: int8 as bigint, numeric as string) and DTO mappers. */

const minor = (v: bigint | string): string => v.toString();

export interface PriceListRow {
  id: string;
  tenant_id: string;
  name: string;
  currency: string;
  kind: PriceListDto['kind'];
  tax_inclusive: boolean;
  priority: number;
  status: PriceListDto['status'];
  version: number;
  created_at: Date;
  updated_at: Date;
}

export const toPriceListDto = (r: PriceListRow): PriceListDto => ({
  id: r.id,
  tenantId: r.tenant_id,
  name: r.name,
  currency: r.currency.trim(),
  kind: r.kind,
  taxInclusive: r.tax_inclusive,
  priority: r.priority,
  status: r.status,
  version: r.version,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

export interface PriceListEntryRow {
  id: string;
  tenant_id: string;
  price_list_id: string;
  variant_id: string;
  price_minor: bigint | string;
  min_quantity: string;
  valid_from: Date | null;
  valid_to: Date | null;
  price_list_version: number;
}

export const toEntryDto = (r: PriceListEntryRow): PriceListEntryDto => ({
  id: r.id,
  tenantId: r.tenant_id,
  priceListId: r.price_list_id,
  variantId: r.variant_id,
  priceMinor: minor(r.price_minor),
  minQuantity: r.min_quantity,
  validFrom: r.valid_from ? r.valid_from.toISOString() : null,
  validTo: r.valid_to ? r.valid_to.toISOString() : null,
  priceListVersion: r.price_list_version,
});

export interface PriceListAssignmentRow {
  id: string;
  tenant_id: string;
  price_list_id: string;
  scope_kind: PriceListAssignmentDto['scopeKind'];
  scope_id: string | null;
  scope_value: string | null;
  priority: number;
  price_list_version: number;
}

export const toAssignmentDto = (r: PriceListAssignmentRow): PriceListAssignmentDto => ({
  id: r.id,
  tenantId: r.tenant_id,
  priceListId: r.price_list_id,
  scopeKind: r.scope_kind,
  scopeId: r.scope_id,
  scopeValue: r.scope_value,
  priority: r.priority,
  priceListVersion: r.price_list_version,
});

export interface PromotionRow {
  id: string;
  tenant_id: string;
  code: string | null;
  name: string;
  description: string | null;
  kind: PromotionDto['kind'];
  rules: PromotionDto['rules'];
  priority: number;
  stack_group: string | null;
  is_exclusive: boolean;
  requires_coupon: boolean;
  max_uses_total: number | null;
  max_uses_per_customer: number | null;
  uses_count: number;
  budget_minor: bigint | string | null;
  spent_minor: bigint | string;
  schedule: PromotionDto['schedule'];
  valid_from: Date;
  valid_to: Date | null;
  status: PromotionDto['status'];
  version: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export const toPromotionDto = (r: PromotionRow): PromotionDto => ({
  id: r.id,
  tenantId: r.tenant_id,
  code: r.code,
  name: r.name,
  description: r.description,
  kind: r.kind,
  rules: r.rules,
  priority: r.priority,
  stackGroup: r.stack_group,
  isExclusive: r.is_exclusive,
  requiresCoupon: r.requires_coupon,
  maxUsesTotal: r.max_uses_total,
  maxUsesPerCustomer: r.max_uses_per_customer,
  usesCount: r.uses_count,
  budgetMinor: r.budget_minor === null ? null : minor(r.budget_minor),
  spentMinor: minor(r.spent_minor),
  schedule: r.schedule,
  validFrom: r.valid_from.toISOString(),
  validTo: r.valid_to ? r.valid_to.toISOString() : null,
  status: r.status,
  version: r.version,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

export interface PromotionScopeRow {
  id: string;
  tenant_id: string;
  promotion_id: string;
  scope_kind: PromotionScopeDto['scopeKind'];
  scope_id: string | null;
  scope_value: string | null;
  promotion_version: number;
}

export const toScopeDto = (r: PromotionScopeRow): PromotionScopeDto => ({
  id: r.id,
  tenantId: r.tenant_id,
  promotionId: r.promotion_id,
  scopeKind: r.scope_kind,
  scopeId: r.scope_id,
  scopeValue: r.scope_value,
  promotionVersion: r.promotion_version,
});

export interface CouponRow {
  id: string;
  tenant_id: string;
  promotion_id: string;
  code: string;
  customer_id: string | null;
  max_uses: number;
  uses_count: number;
  expires_at: Date | null;
  status: CouponDto['status'];
  created_at: Date;
}

export const toCouponDto = (r: CouponRow): CouponDto => ({
  id: r.id,
  tenantId: r.tenant_id,
  promotionId: r.promotion_id,
  code: r.code,
  customerId: r.customer_id,
  maxUses: r.max_uses,
  usesCount: r.uses_count,
  expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
  status: r.status,
  createdAt: r.created_at.toISOString(),
});
