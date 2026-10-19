import { Injectable } from '@nestjs/common';
import { type PricedOrderDto, type PricingPreviewRequest, toPricedOrderDto } from '@pos/contracts';
import type { TenantScopedDb } from '@pos/db';
import { UnknownCurrencyError, priceEngine } from '@pos/domain-core';

import { AuthorizationService, UnitOfWork, ValidationError } from '../kernel/public/index.js';
import { HierarchyService } from '../tenancy/public/index.js';
import { normaliseCouponCode } from './coupons.service.js';
import { PRICING_PERMISSIONS } from './permissions.js';

interface ListRow {
  id: string;
  name: string;
  currency: string;
  kind: priceEngine.PriceListKind;
  tax_inclusive: boolean;
  priority: number;
  status: priceEngine.PriceListStatus;
}
interface EntryRow {
  id: string;
  price_list_id: string;
  variant_id: string;
  price_minor: bigint | string;
  min_quantity: string;
  valid_from: Date | null;
  valid_to: Date | null;
}
interface AssignmentRow {
  id: string;
  price_list_id: string;
  scope_kind: priceEngine.PriceListScopeKind;
  scope_id: string | null;
  scope_value: string | null;
  priority: number;
}
interface PromotionLoadRow {
  id: string;
  code: string | null;
  name: string;
  kind: priceEngine.PromotionKind;
  rules: priceEngine.PromotionRules;
  priority: number;
  stack_group: string | null;
  is_exclusive: boolean;
  requires_coupon: boolean;
  max_uses_total: number | null;
  max_uses_per_customer: number | null;
  uses_count: number;
  budget_minor: bigint | string | null;
  spent_minor: bigint | string;
  schedule: priceEngine.PromotionSchedule;
  valid_from: Date;
  valid_to: Date | null;
  status: priceEngine.PromotionStatus;
  created_at: Date;
}
interface ScopeLoadRow {
  promotion_id: string;
  scope_kind: priceEngine.PromotionScopeKind;
  scope_id: string | null;
  scope_value: string | null;
}
interface CouponLoadRow {
  id: string;
  promotion_id: string;
  code: string;
  customer_id: string | null;
  max_uses: number;
  uses_count: number;
  expires_at: Date | null;
  status: 'active' | 'redeemed' | 'expired' | 'void';
}

/**
 * `POST /v1/pricing/preview`: loads the price lists, promotions and coupons in scope for a
 * location from the database, builds the engine's PricingContext and runs the same `priceOrder`
 * the POS runs offline (docs/01-system-architecture.md §7.2). Catalog facts (default price, tax
 * class, categories) come from the caller's draft, so this module never reads catalog tables.
 *
 * Interim, until the Wave 2 integration slice: the location's time zone is supplied by the
 * caller (UTC when absent) and tax comes from the request's `taxRules` or the engine's AU GST
 * stub, because neither the tenancy module's location read nor S-F2's tax resolver is a public
 * port yet.
 */
@Injectable()
export class PricingPreviewService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly hierarchy: HierarchyService,
  ) {}

  async preview(request: PricingPreviewRequest): Promise<PricedOrderDto> {
    await this.authz.assert(PRICING_PERMISSIONS.preview, {
      kind: 'location',
      id: request.locationId,
    });
    const at = request.at ?? new Date().toISOString();
    const draft = request.draft as priceEngine.OrderDraft;
    const context = await this.uow.read(async (db) => {
      const scope = await this.hierarchy.requireScope(db, 'location', request.locationId);
      const orgUnitPath = scope.path.filter((s) => s.kind === 'org_unit').map((s) => s.id);
      return this.buildContext(db, request, draft, at, orgUnitPath);
    });
    try {
      const priced = priceEngine.priceOrder(draft, context);
      return toPricedOrderDto(priced, { includeTrace: request.includeTrace !== false });
    } catch (error) {
      // Input the schema cannot rule out (a price missing everywhere, a discount over the base): the caller's to fix.
      if (
        error instanceof RangeError ||
        error instanceof TypeError ||
        error instanceof UnknownCurrencyError
      ) {
        throw new ValidationError({ pricing: error.message });
      }
      throw error;
    }
  }

  private async buildContext(
    db: TenantScopedDb,
    request: PricingPreviewRequest,
    draft: priceEngine.OrderDraft,
    at: string,
    orgUnitPath: readonly string[],
  ): Promise<priceEngine.PricingContext> {
    const variantIds = [...new Set(draft.lines.map((l) => l.variantId))];
    const [priceLists, promotions, coupons] = await Promise.all([
      this.loadPriceLists(db, draft.currency, variantIds),
      this.loadPromotions(db, at),
      this.loadCoupons(db, draft.couponCodes ?? []),
    ]);
    return {
      at,
      timezone: request.timezone ?? 'UTC',
      locationId: request.locationId,
      orgUnitPath,
      ...(request.channel ? { channel: request.channel } : {}),
      ...(request.jurisdiction
        ? {
            jurisdiction: {
              country: request.jurisdiction.country,
              region: request.jurisdiction.region ?? null,
            },
          }
        : {}),
      priceLists,
      promotions,
      coupons,
      ...(request.taxRules
        ? {
            taxResolver: new priceEngine.StaticTaxRuleResolver(
              request.taxRules as priceEngine.StaticTaxRule[],
              {
                stackMatches: request.stackTaxRules === true,
              },
            ),
          }
        : {}),
      ...(request.cashRounding !== undefined ? { cashRounding: request.cashRounding } : {}),
    };
  }

  private async loadPriceLists(
    db: TenantScopedDb,
    currency: string,
    variantIds: readonly string[],
  ): Promise<priceEngine.PriceListDefinition[]> {
    const lists = await db.query<ListRow>(
      `SELECT id, name, currency, kind, tax_inclusive, priority, status FROM pricing.price_lists
       WHERE tenant_id = $1 AND status = 'active' AND currency = $2`,
      [db.tenantId, currency.toUpperCase()],
    );
    if (lists.length === 0) return [];
    const ids = lists.map((l) => l.id);
    const [entries, assignments] = await Promise.all([
      db.query<EntryRow>(
        `SELECT id, price_list_id, variant_id, price_minor, min_quantity, valid_from, valid_to
         FROM pricing.price_list_entries
         WHERE tenant_id = $1 AND price_list_id = ANY($2::uuid[]) AND variant_id = ANY($3::uuid[])`,
        [db.tenantId, ids, variantIds],
      ),
      db.query<AssignmentRow>(
        `SELECT id, price_list_id, scope_kind, scope_id, scope_value, priority
         FROM pricing.price_list_assignments WHERE tenant_id = $1 AND price_list_id = ANY($2::uuid[])`,
        [db.tenantId, ids],
      ),
    ]);
    return lists.map((l) => ({
      id: l.id,
      name: l.name,
      currency: l.currency.trim(),
      kind: l.kind,
      taxInclusive: l.tax_inclusive,
      priority: l.priority,
      status: l.status,
      entries: entries
        .filter((e) => e.price_list_id === l.id)
        .map((e) => ({
          id: e.id,
          variantId: e.variant_id,
          priceMinor: e.price_minor,
          minQuantity: e.min_quantity,
          validFrom: e.valid_from ? e.valid_from.toISOString() : null,
          validTo: e.valid_to ? e.valid_to.toISOString() : null,
        })),
      assignments: assignments
        .filter((a) => a.price_list_id === l.id)
        .map((a) => ({
          id: a.id,
          scopeKind: a.scope_kind,
          scopeId: a.scope_id,
          scopeValue: a.scope_value,
          priority: a.priority,
        })),
    }));
  }

  private async loadPromotions(
    db: TenantScopedDb,
    at: string,
  ): Promise<priceEngine.PromotionDefinition[]> {
    const rows = await db.query<PromotionLoadRow>(
      `SELECT id, code, name, kind, rules, priority, stack_group, is_exclusive, requires_coupon, max_uses_total,
              max_uses_per_customer, uses_count, budget_minor, spent_minor, schedule, valid_from, valid_to, status, created_at
       FROM pricing.promotions
       WHERE tenant_id = $1 AND status = 'active' AND valid_from <= $2::timestamptz
         AND (valid_to IS NULL OR valid_to > $2::timestamptz)`,
      [db.tenantId, at],
    );
    if (rows.length === 0) return [];
    const scopes = await db.query<ScopeLoadRow>(
      `SELECT promotion_id, scope_kind, scope_id, scope_value FROM pricing.promotion_scopes
       WHERE tenant_id = $1 AND promotion_id = ANY($2::uuid[])`,
      [db.tenantId, rows.map((r) => r.id)],
    );
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      kind: r.kind,
      rules: r.rules,
      priority: r.priority,
      stackGroup: r.stack_group,
      isExclusive: r.is_exclusive,
      requiresCoupon: r.requires_coupon,
      maxUsesTotal: r.max_uses_total,
      maxUsesPerCustomer: r.max_uses_per_customer,
      usesCount: r.uses_count,
      budgetMinor: r.budget_minor,
      spentMinor: r.spent_minor,
      schedule: r.schedule,
      validFrom: r.valid_from.toISOString(),
      validTo: r.valid_to ? r.valid_to.toISOString() : null,
      status: r.status,
      createdAt: r.created_at.toISOString(),
      scopes: scopes
        .filter((s) => s.promotion_id === r.id)
        .map((s) => ({ scopeKind: s.scope_kind, scopeId: s.scope_id, scopeValue: s.scope_value })),
    }));
  }

  private async loadCoupons(
    db: TenantScopedDb,
    codes: readonly string[],
  ): Promise<priceEngine.CouponDefinition[]> {
    if (codes.length === 0) return [];
    const rows = await db.query<CouponLoadRow>(
      `SELECT id, promotion_id, code, customer_id, max_uses, uses_count, expires_at, status
       FROM pricing.coupons WHERE tenant_id = $1 AND code = ANY($2::text[])`,
      [db.tenantId, codes.map(normaliseCouponCode)],
    );
    return rows.map((c) => ({
      id: c.id,
      promotionId: c.promotion_id,
      code: c.code,
      customerId: c.customer_id,
      maxUses: c.max_uses,
      usesCount: c.uses_count,
      expiresAt: c.expires_at ? c.expires_at.toISOString() : null,
      status: c.status,
    }));
  }
}
