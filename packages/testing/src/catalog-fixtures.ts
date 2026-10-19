import { randomUUID } from 'node:crypto';

import type { Pool } from '@pos/db';

import type { HierarchyFixture } from './fixtures.js';

/** Fixture names the F2 routes use in `x-fixture` / `$fixture:` placeholders (see apps/api catalog controllers). */
export interface CatalogFixture {
  readonly categoryId: string;
  readonly taxClassId: string;
  readonly taxRuleId: string;
  readonly unitCode: string;
  readonly conversionId: string;
  readonly itemId: string;
  readonly variantId: string;
  readonly childVariantId: string;
  readonly barcodeId: string;
  readonly componentId: string;
  readonly groupId: string;
  readonly modifierId: string;
  readonly menuId: string;
  readonly sectionId: string;
  readonly assignmentId: string;
  readonly availabilityId: string;
  readonly supplierId: string;
  readonly supplierItemId: string;
  readonly importId: string;
}

/**
 * One of everything F2 exposes under a hierarchy fixture (superuser pool, RLS bypassed): category,
 * GST class + rule, units, an item with two variants (parent/child component), a barcode, a modifier
 * group linked to the item, a menu with a section and an assignment at the location, an availability
 * row, a supplier with a supplier item and an import job.
 */
export async function createCatalogFixture(
  admin: Pool,
  h: HierarchyFixture,
): Promise<CatalogFixture> {
  const t = h.tenantId;
  const ids = {
    categoryId: randomUUID(),
    taxClassId: randomUUID(),
    taxRuleId: randomUUID(),
    unitCode: `fx_${randomUUID().slice(0, 8)}`,
    conversionId: randomUUID(),
    itemId: randomUUID(),
    variantId: randomUUID(),
    childVariantId: randomUUID(),
    barcodeId: randomUUID(),
    componentId: randomUUID(),
    groupId: randomUUID(),
    modifierId: randomUUID(),
    menuId: randomUUID(),
    sectionId: randomUUID(),
    assignmentId: randomUUID(),
    availabilityId: randomUUID(),
    supplierId: randomUUID(),
    supplierItemId: randomUUID(),
    importId: randomUUID(),
  };
  const q = (sql: string, params: unknown[]) => admin.query(sql, params);
  await q(
    "INSERT INTO catalog.tax_classes (id, tenant_id, code, name) VALUES ($1, $2, 'standard', 'GST standard')",
    [ids.taxClassId, t],
  );
  await q(
    `INSERT INTO pricing.tax_rules (id, tenant_id, name, jurisdiction_country, tax_class_id, kind, rate, valid_from)
     VALUES ($1, $2, 'GST 10%', 'AU', $3, 'vat_gst', 0.10, DATE '2000-07-01')`,
    [ids.taxRuleId, t, ids.taxClassId],
  );
  await q(
    "INSERT INTO catalog.units_of_measure (tenant_id, code, name, dimension) VALUES ($1, 'each', 'Each', 'count'), ($1, 'kg', 'Kilogram', 'mass'), ($1, 'g', 'Gram', 'mass'), ($1, $2, 'Fixture unit', 'count')",
    [t, ids.unitCode],
  );
  await q(
    "INSERT INTO catalog.categories (id, tenant_id, kind, code, name, path, default_tax_class_id) VALUES ($1, $2, 'retail', 'drinks', 'Drinks', '/drinks', $3)",
    [ids.categoryId, t, ids.taxClassId],
  );
  await q(
    "INSERT INTO catalog.items (id, tenant_id, kind, name, category_id, tax_class_id) VALUES ($1, $2, 'product', 'Fixture cola', $3, $4)",
    [ids.itemId, t, ids.categoryId, ids.taxClassId],
  );
  await q(
    `INSERT INTO catalog.item_variants (id, tenant_id, item_id, sku, name, is_default, default_price_minor) VALUES
       ($1, $3, $4, $5, '375 ml can', true, 350), ($2, $3, $4, $6, '1.25 l bottle', false, 450)`,
    [
      ids.variantId,
      ids.childVariantId,
      t,
      ids.itemId,
      `FX-${ids.variantId.slice(0, 8)}`,
      `FX-${ids.childVariantId.slice(0, 8)}`,
    ],
  );
  await q(
    "INSERT INTO catalog.barcodes (id, tenant_id, variant_id, code, kind, is_primary) VALUES ($1, $2, $3, $4, 'ean13', true)",
    [
      ids.barcodeId,
      t,
      ids.variantId,
      `9${ids.barcodeId.replace(/\D/g, '').slice(0, 12).padEnd(12, '0')}`,
    ],
  );
  await q(
    'INSERT INTO catalog.item_components (id, tenant_id, parent_variant_id, child_variant_id, quantity) VALUES ($1, $2, $3, $4, 2)',
    [ids.componentId, t, ids.variantId, ids.childVariantId],
  );
  await q(
    "INSERT INTO catalog.unit_conversions (id, tenant_id, variant_id, from_unit, to_unit, factor) VALUES ($1, $2, NULL, 'kg', 'g', 1000)",
    [ids.conversionId, t],
  );
  await q(
    "INSERT INTO catalog.modifier_groups (id, tenant_id, name, selection_min, selection_max) VALUES ($1, $2, 'Size', 0, 1)",
    [ids.groupId, t],
  );
  await q(
    "INSERT INTO catalog.modifiers (id, tenant_id, group_id, name, price_delta_minor) VALUES ($1, $2, $3, 'Large', 150)",
    [ids.modifierId, t, ids.groupId],
  );
  await q(
    'INSERT INTO catalog.item_modifier_groups (tenant_id, item_id, group_id) VALUES ($1, $2, $3)',
    [t, ids.itemId, ids.groupId],
  );
  await q(
    "INSERT INTO catalog.menus (id, tenant_id, name, status) VALUES ($1, $2, 'Fixture menu', 'published')",
    [ids.menuId, t],
  );
  await q(
    "INSERT INTO catalog.menu_sections (id, tenant_id, menu_id, name) VALUES ($1, $2, $3, 'Drinks')",
    [ids.sectionId, t, ids.menuId],
  );
  await q(
    'INSERT INTO catalog.menu_section_items (tenant_id, section_id, item_id) VALUES ($1, $2, $3)',
    [t, ids.sectionId, ids.itemId],
  );
  await q(
    "INSERT INTO catalog.menu_assignments (id, tenant_id, menu_id, scope_kind, scope_id) VALUES ($1, $2, $3, 'location', $4)",
    [ids.assignmentId, t, ids.menuId, h.locationId],
  );
  await q(
    "INSERT INTO catalog.item_availability (id, tenant_id, location_id, item_id, is_available, reason) VALUES ($1, $2, $3, $4, false, 'fixture')",
    [ids.availabilityId, t, h.locationId, ids.itemId],
  );
  await q(
    "INSERT INTO catalog.suppliers (id, tenant_id, code, name) VALUES ($1, $2, 'FX', 'Fixture supplier')",
    [ids.supplierId, t],
  );
  await q(
    "INSERT INTO catalog.supplier_items (id, tenant_id, supplier_id, variant_id, cost_minor, currency) VALUES ($1, $2, $3, $4, 200, 'AUD')",
    [ids.supplierItemId, t, ids.supplierId, ids.variantId],
  );
  await q(
    "INSERT INTO catalog.import_jobs (id, tenant_id, file_name, status, dry_run, report_csv) VALUES ($1, $2, 'fixture.csv', 'validated', true, 'line,column,code,message\r\n')",
    [ids.importId, t],
  );
  return ids;
}
