import { randomUUID } from 'node:crypto';

import type { Pool } from '@pos/db';

export interface PricingFixture {
  readonly variantId: string;
  readonly priceListId: string;
  /** A second, draft price list that can be deleted. */
  readonly draftPriceListId: string;
  readonly priceListEntryId: string;
  readonly priceListAssignmentId: string;
  readonly promotionId: string;
  /** A draft promotion with no scopes that can be deleted. */
  readonly draftPromotionId: string;
  readonly promotionScopeId: string;
  readonly couponId: string;
}

/**
 * Pricing rows for one tenant, inserted with the superuser pool (RLS bypassed): a catalog item
 * and variant, an active price list with one entry and a location assignment, a draft list, an
 * active promotion scoped to the location, a draft promotion and a coupon. The names match the
 * `x-fixture` placeholders the pricing routes declare, so the cross-tenant harness registry is
 * `{ ...hierarchyFixtures, ...await createPricingFixture(admin, hierarchy) }`.
 */
export async function createPricingFixture(
  admin: Pool,
  tenant: { readonly tenantId: string; readonly locationId: string },
): Promise<PricingFixture> {
  const ids = {
    itemId: randomUUID(),
    variantId: randomUUID(),
    priceListId: randomUUID(),
    draftPriceListId: randomUUID(),
    priceListEntryId: randomUUID(),
    priceListAssignmentId: randomUUID(),
    promotionId: randomUUID(),
    draftPromotionId: randomUUID(),
    promotionScopeId: randomUUID(),
    couponId: randomUUID(),
  };
  const t = tenant.tenantId;
  await admin.query(
    `INSERT INTO catalog.items (id, tenant_id, kind, name) VALUES ($1, $2, 'product', 'Fixture item')`,
    [ids.itemId, t],
  );
  await admin.query(
    `INSERT INTO catalog.item_variants (id, tenant_id, item_id, sku, default_price_minor, is_default)
     VALUES ($1, $2, $3, $4, 1000, true)`,
    [ids.variantId, t, ids.itemId, `fx-${ids.variantId.slice(0, 8)}`],
  );
  await admin.query(
    `INSERT INTO pricing.price_lists (id, tenant_id, name, currency, kind) VALUES
       ($1, $3, 'Fixture list', 'AUD', 'retail'),
       ($2, $3, 'Fixture draft list', 'AUD', 'retail')`,
    [ids.priceListId, ids.draftPriceListId, t],
  );
  await admin.query(`UPDATE pricing.price_lists SET status = 'draft' WHERE id = $1`, [
    ids.draftPriceListId,
  ]);
  await admin.query(
    `INSERT INTO pricing.price_list_entries (id, tenant_id, price_list_id, variant_id, price_minor)
     VALUES ($1, $2, $3, $4, 900)`,
    [ids.priceListEntryId, t, ids.priceListId, ids.variantId],
  );
  await admin.query(
    `INSERT INTO pricing.price_list_assignments (id, tenant_id, price_list_id, scope_kind, scope_id)
     VALUES ($1, $2, $3, 'location', $4)`,
    [ids.priceListAssignmentId, t, ids.priceListId, tenant.locationId],
  );
  const rules = JSON.stringify({
    version: 1,
    targets: { all: true },
    effect: { kind: 'percent_off', percent: '10' },
  });
  await admin.query(
    `INSERT INTO pricing.promotions (id, tenant_id, name, kind, rules, valid_from, status, requires_coupon) VALUES
       ($1, $3, 'Fixture promotion', 'percent_off', $4, '2026-01-01T00:00:00Z', 'active', true),
       ($2, $3, 'Fixture draft promotion', 'percent_off', $4, '2026-01-01T00:00:00Z', 'draft', false)`,
    [ids.promotionId, ids.draftPromotionId, t, rules],
  );
  await admin.query(
    `INSERT INTO pricing.promotion_scopes (id, tenant_id, promotion_id, scope_kind, scope_id)
     VALUES ($1, $2, $3, 'location', $4)`,
    [ids.promotionScopeId, t, ids.promotionId, tenant.locationId],
  );
  await admin.query(
    `INSERT INTO pricing.coupons (id, tenant_id, promotion_id, code) VALUES ($1, $2, $3, $4)`,
    [ids.couponId, t, ids.promotionId, `FX-${ids.couponId.slice(0, 8).toUpperCase()}`],
  );
  return {
    variantId: ids.variantId,
    priceListId: ids.priceListId,
    draftPriceListId: ids.draftPriceListId,
    priceListEntryId: ids.priceListEntryId,
    priceListAssignmentId: ids.priceListAssignmentId,
    promotionId: ids.promotionId,
    draftPromotionId: ids.draftPromotionId,
    promotionScopeId: ids.promotionScopeId,
    couponId: ids.couponId,
  };
}
