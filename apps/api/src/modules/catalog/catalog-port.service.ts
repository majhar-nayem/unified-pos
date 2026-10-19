import { Injectable } from '@nestjs/common';
import type { BarcodeHit, CatalogPort, CatalogVariantSnapshot } from '@pos/domain-core';

import { UnitOfWork } from '../kernel/public/index.js';

interface SnapshotRow {
  variant_id: string;
  item_id: string;
  item_name: string;
  variant_name: string | null;
  sku: string | null;
  kind: string;
  sold_by: string;
  unit_of_measure: string;
  tax_class_id: string | null;
  tax_class_code: string | null;
  default_price_minor: bigint | null;
  track_inventory: boolean;
  is_age_restricted: boolean;
  min_age: number | null;
  item_status: string;
  variant_status: string;
  item_version: number;
  variant_version: number;
}

const SNAPSHOT_COLUMNS = `v.id AS variant_id, i.id AS item_id, i.name AS item_name, v.name AS variant_name, v.sku, i.kind, i.sold_by,
         i.unit_of_measure, i.tax_class_id, tc.code AS tax_class_code, v.default_price_minor, i.track_inventory,
         i.is_age_restricted, i.min_age, i.status AS item_status, v.status AS variant_status,
         i.version AS item_version, v.version AS variant_version`;
const SNAPSHOT_FROM = `
  FROM catalog.item_variants v
  JOIN catalog.items i ON i.tenant_id = v.tenant_id AND i.id = v.item_id
  LEFT JOIN catalog.tax_classes tc ON tc.tenant_id = i.tenant_id AND tc.id = i.tax_class_id`;
const SNAPSHOT_SQL = `SELECT ${SNAPSHOT_COLUMNS} ${SNAPSHOT_FROM}`;

function toSnapshot(r: SnapshotRow): CatalogVariantSnapshot {
  return {
    variantId: r.variant_id,
    itemId: r.item_id,
    itemName: r.item_name,
    variantName: r.variant_name,
    sku: r.sku,
    kind: r.kind,
    soldBy: r.sold_by,
    unitOfMeasure: r.unit_of_measure,
    taxClassId: r.tax_class_id,
    taxClassCode: r.tax_class_code,
    defaultPriceMinor: r.default_price_minor,
    trackInventory: r.track_inventory,
    isAgeRestricted: r.is_age_restricted,
    minAge: r.min_age,
    itemStatus: r.item_status,
    variantStatus: r.variant_status,
    itemVersion: r.item_version,
    variantVersion: r.variant_version,
  };
}

/**
 * CatalogPort (docs/03 §15.1) over the tenant's catalog: what the order and price engines need
 * (tax class, list price, tracking and age flags) without touching catalog tables. No
 * authorization here: callers are other modules already inside an authorised request.
 */
@Injectable()
export class CatalogPortService implements CatalogPort {
  constructor(private readonly uow: UnitOfWork) {}

  async variantSnapshot(variantId: string): Promise<CatalogVariantSnapshot | null> {
    return (await this.variantSnapshots([variantId])).get(variantId) ?? null;
  }

  async variantSnapshots(
    variantIds: readonly string[],
  ): Promise<ReadonlyMap<string, CatalogVariantSnapshot>> {
    if (variantIds.length === 0) return new Map();
    const rows = await this.uow.read((db) =>
      db.query<SnapshotRow>(`${SNAPSHOT_SQL} WHERE v.tenant_id = $1 AND v.id = ANY($2::uuid[])`, [
        db.tenantId,
        variantIds,
      ]),
    );
    return new Map(rows.map((r) => [r.variant_id, toSnapshot(r)]));
  }

  async lookupBySku(sku: string): Promise<CatalogVariantSnapshot | null> {
    const rows = await this.uow.read((db) =>
      db.query<SnapshotRow>(`${SNAPSHOT_SQL} WHERE v.tenant_id = $1 AND v.sku = $2`, [
        db.tenantId,
        sku,
      ]),
    );
    return rows[0] ? toSnapshot(rows[0]) : null;
  }

  async lookupByBarcode(code: string): Promise<BarcodeHit | null> {
    const rows = await this.uow.read((db) =>
      db.query<SnapshotRow & { pack_quantity: string; barcode_kind: string }>(
        `SELECT b.pack_quantity, b.kind AS barcode_kind, ${SNAPSHOT_COLUMNS} ${SNAPSHOT_FROM}
         JOIN catalog.barcodes b ON b.tenant_id = v.tenant_id AND b.variant_id = v.id
         WHERE v.tenant_id = $1 AND b.code = $2`,
        [db.tenantId, code],
      ),
    );
    const row = rows[0];
    return row
      ? {
          snapshot: toSnapshot(row),
          packQuantity: row.pack_quantity,
          barcodeKind: row.barcode_kind,
        }
      : null;
  }
}
