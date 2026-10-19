import { Injectable } from '@nestjs/common';
import type {
  BarcodeDto,
  CreateBarcode,
  CreateItem,
  CreateVariant,
  ItemDetailDto,
  ItemDto,
  ItemListQuery,
  ItemSearchQuery,
  ItemSearchResultDto,
  Page,
  UpdateItem,
  UpdateVariant,
  VariantDto,
  VariantLookupDto,
  VariantWithBarcodesDto,
} from '@pos/contracts';
import { newId, type TenantScopedDb, type TenantUnitOfWork } from '@pos/db';

import {
  AuthorizationService,
  ConflictError,
  NotFoundError,
  UnitOfWork,
  VersionConflictError,
} from '../../kernel/public/index.js';
import {
  type BarcodeRow,
  type ItemModifierGroupRow,
  type ItemRow,
  type VariantRow,
  toBarcodeDto,
  toItemDto,
  toItemModifierGroupDto,
  toVariantDto,
} from '../rows.js';
import { emitCatalogChanged } from '../shared/events.js';
import { buildPatch, queryPage } from '../shared/sql.js';

const ITEM_COLUMNS = {
  kind: 'kind',
  name: 'name',
  shortName: 'short_name',
  description: 'description',
  categoryId: 'category_id',
  brandName: 'brand_name',
  manufacturer: 'manufacturer',
  taxClassId: 'tax_class_id',
  soldBy: 'sold_by',
  unitOfMeasure: 'unit_of_measure',
  trackInventory: 'track_inventory',
  isAgeRestricted: 'is_age_restricted',
  minAge: 'min_age',
  images: { column: 'images', json: true },
  attributes: { column: 'attributes', json: true },
  allergens: 'allergens',
  dietaryTags: 'dietary_tags',
  kitchenTags: 'kitchen_tags',
  prepTimeSeconds: 'prep_time_seconds',
  status: 'status',
} as const;

const VARIANT_COLUMNS = {
  sku: 'sku',
  name: 'name',
  optionValues: { column: 'option_values', json: true },
  isDefault: 'is_default',
  defaultPriceMinor: 'default_price_minor',
  costMinor: 'cost_minor',
  weightGrams: 'weight_grams',
  dimensions: { column: 'dimensions', json: true },
  trackSerials: 'track_serials',
  trackLots: 'track_lots',
  shelfLifeDays: 'shelf_life_days',
  status: 'status',
} as const;

/**
 * Word-similarity floor for fuzzy hits (pg_trgm `<%`: the best matching extent of the name, so a typo in
 * one word of a long name still scores high while unrelated names stay far below the floor).
 */
const FUZZY_THRESHOLD = 0.5;

export interface SearchRow extends ItemRow {
  text_rank: number;
  similarity: number;
}

@Injectable()
export class ItemsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
  ) {}

  // ---------------------------------------------------------------- items

  async list(query: ItemListQuery): Promise<Page<ItemDto>> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read((db) => {
      const where = [];
      if (query.kind) where.push({ sql: 't.kind = ?', value: query.kind });
      if (query.status) where.push({ sql: 't.status = ?', value: query.status });
      if (query.categoryId) where.push({ sql: 't.category_id = ?', value: query.categoryId });
      return queryPage<ItemRow, ItemDto>(
        db,
        { from: 'catalog.items t', where, cursor: query.cursor, limit: query.limit },
        toItemDto,
      );
    });
  }

  async get(id: string): Promise<ItemDetailDto> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read((db) => this.detail(db, id));
  }

  async create(input: CreateItem): Promise<ItemDetailDto> {
    await this.authz.assert('catalog.item.manage');
    return this.uow.run(async (uow) => {
      const item = await this.insertItem(uow, input);
      const variants = input.variants ?? [];
      for (const [index, variant] of variants.entries()) {
        await this.insertVariant(uow, item, {
          ...variant,
          isDefault: variant.isDefault ?? (index === 0 && !variants.some((v) => v.isDefault)),
        });
      }
      return this.detail(uow.db, item.id);
    });
  }

  async insertItem(uow: TenantUnitOfWork, input: CreateItem): Promise<ItemDto> {
    const id = newId();
    const rows = await uow.db.query<ItemRow>(
      `INSERT INTO catalog.items (id, tenant_id, kind, name, short_name, description, category_id, brand_name, manufacturer, tax_class_id,
         sold_by, unit_of_measure, track_inventory, is_age_restricted, min_age, images, attributes, allergens, dietary_tags, kitchen_tags,
         prep_time_seconds, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, 'unit'), COALESCE($12, 'each'), COALESCE($13, true), COALESCE($14, false), $15,
         COALESCE($16::jsonb, '[]'::jsonb), COALESCE($17::jsonb, '{}'::jsonb), COALESCE($18::text[], '{}'), COALESCE($19::text[], '{}'), COALESCE($20::text[], '{}'),
         $21, COALESCE($22, 'active'))
       RETURNING *`,
      [
        id,
        uow.tenantId,
        input.kind,
        input.name,
        input.shortName ?? null,
        input.description ?? null,
        input.categoryId ?? null,
        input.brandName ?? null,
        input.manufacturer ?? null,
        input.taxClassId ?? null,
        input.soldBy ?? null,
        input.unitOfMeasure ?? null,
        input.trackInventory ?? null,
        input.isAgeRestricted ?? null,
        input.minAge ?? null,
        input.images ? JSON.stringify(input.images) : null,
        input.attributes ? JSON.stringify(input.attributes) : null,
        input.allergens ?? null,
        input.dietaryTags ?? null,
        input.kitchenTags ?? null,
        input.prepTimeSeconds ?? null,
        input.status ?? null,
      ],
    );
    const created = toItemDto(rows[0]!);
    uow.audit({
      action: 'catalog.item.created',
      resourceKind: 'item',
      resourceId: id,
      after: created,
    });
    emitCatalogChanged(uow, {
      entity: 'item',
      entityId: id,
      change: 'created',
      version: 1,
      itemId: id,
    });
    return created;
  }

  async update(id: string, patch: UpdateItem, expectedVersion: number): Promise<ItemDetailDto> {
    await this.authz.assert('catalog.item.manage');
    return this.uow.run(async (uow) => {
      const before = await this.requireItem(uow.db, id);
      const { set, params } = buildPatch(patch, ITEM_COLUMNS, 3);
      if (!set) {
        if (before.version !== expectedVersion)
          throw new VersionConflictError(expectedVersion, before.version);
        return this.detail(uow.db, id);
      }
      const rows = await uow.db.query<ItemRow>(
        `UPDATE catalog.items SET ${set}, version = version + 1, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND version = ${expectedVersion} RETURNING *`,
        [uow.tenantId, id, ...params],
      );
      if (rows.length === 0) throw new VersionConflictError(expectedVersion, before.version);
      const after = toItemDto(rows[0]!);
      uow.audit({
        action: 'catalog.item.updated',
        resourceKind: 'item',
        resourceId: id,
        before,
        after,
      });
      emitCatalogChanged(uow, {
        entity: 'item',
        entityId: id,
        change: 'updated',
        version: after.version,
        itemId: id,
      });
      return this.detail(uow.db, id);
    });
  }

  // ------------------------------------------------------------- variants

  async listVariants(itemId: string): Promise<VariantWithBarcodesDto[]> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read(async (db) => {
      await this.requireItem(db, itemId);
      return this.variantsOf(db, itemId);
    });
  }

  async getVariant(id: string): Promise<VariantWithBarcodesDto> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read(async (db) => {
      const variant = await this.requireVariant(db, id);
      return { ...variant, barcodes: await this.barcodesOf(db, [id]) };
    });
  }

  async createVariant(itemId: string, input: CreateVariant): Promise<VariantWithBarcodesDto> {
    await this.authz.assert('catalog.item.manage');
    return this.uow.run(async (uow) => {
      const item = await this.requireItem(uow.db, itemId);
      const created = await this.insertVariant(uow, item, input);
      await this.bumpItem(uow, itemId);
      return { ...created, barcodes: await this.barcodesOf(uow.db, [created.id]) };
    });
  }

  async insertVariant(
    uow: TenantUnitOfWork,
    item: ItemDto,
    input: CreateVariant,
  ): Promise<VariantDto> {
    const id = newId();
    if (input.isDefault) await this.clearDefault(uow.db, item.id);
    const rows = await uow.db.query<VariantRow>(
      `INSERT INTO catalog.item_variants (id, tenant_id, item_id, sku, name, option_values, is_default, default_price_minor, cost_minor,
         weight_grams, dimensions, track_serials, track_lots, shelf_life_days)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::jsonb, '{}'::jsonb), COALESCE($7, false), $8, $9, $10, $11::jsonb, COALESCE($12, false), COALESCE($13, false), $14)
       RETURNING *`,
      [
        id,
        uow.tenantId,
        item.id,
        input.sku ?? null,
        input.name ?? null,
        input.optionValues ? JSON.stringify(input.optionValues) : null,
        input.isDefault ?? null,
        input.defaultPriceMinor ?? null,
        input.costMinor ?? null,
        input.weightGrams ?? null,
        input.dimensions ? JSON.stringify(input.dimensions) : null,
        input.trackSerials ?? null,
        input.trackLots ?? null,
        input.shelfLifeDays ?? null,
      ],
    );
    const created = toVariantDto(rows[0]!);
    uow.audit({
      action: 'catalog.variant.created',
      resourceKind: 'item_variant',
      resourceId: id,
      after: created,
    });
    emitCatalogChanged(uow, {
      entity: 'item_variant',
      entityId: id,
      change: 'created',
      version: 1,
      itemId: item.id,
    });
    for (const barcode of input.barcodes ?? []) await this.insertBarcode(uow, created, barcode);
    return created;
  }

  async updateVariant(
    id: string,
    patch: UpdateVariant,
    expectedVersion: number,
  ): Promise<VariantWithBarcodesDto> {
    await this.authz.assert('catalog.item.manage');
    return this.uow.run(async (uow) => {
      const before = await this.requireVariant(uow.db, id);
      if (patch.isDefault === true && !before.isDefault)
        await this.clearDefault(uow.db, before.itemId);
      const { set, params } = buildPatch(patch, VARIANT_COLUMNS, 3);
      if (!set) {
        if (before.version !== expectedVersion)
          throw new VersionConflictError(expectedVersion, before.version);
        return { ...before, barcodes: await this.barcodesOf(uow.db, [id]) };
      }
      const rows = await uow.db.query<VariantRow>(
        `UPDATE catalog.item_variants SET ${set}, version = version + 1, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND version = ${expectedVersion} RETURNING *`,
        [uow.tenantId, id, ...params],
      );
      if (rows.length === 0) throw new VersionConflictError(expectedVersion, before.version);
      const after = toVariantDto(rows[0]!);
      uow.audit({
        action: 'catalog.variant.updated',
        resourceKind: 'item_variant',
        resourceId: id,
        before,
        after,
      });
      emitCatalogChanged(uow, {
        entity: 'item_variant',
        entityId: id,
        change: 'updated',
        version: after.version,
        itemId: after.itemId,
      });
      await this.bumpItem(uow, after.itemId);
      return { ...after, barcodes: await this.barcodesOf(uow.db, [id]) };
    });
  }

  // ------------------------------------------------------------- barcodes

  async addBarcode(variantId: string, input: CreateBarcode): Promise<BarcodeDto> {
    await this.authz.assert('catalog.item.manage');
    return this.uow.run(async (uow) => {
      const variant = await this.requireVariant(uow.db, variantId);
      const created = await this.insertBarcode(uow, variant, input);
      await this.bumpItem(uow, variant.itemId);
      return created;
    });
  }

  async insertBarcode(
    uow: TenantUnitOfWork,
    variant: VariantDto,
    input: CreateBarcode,
  ): Promise<BarcodeDto> {
    const taken = await uow.db.maybeOne<{ variant_id: string }>(
      'SELECT variant_id FROM catalog.barcodes WHERE tenant_id = $1 AND code = $2',
      [uow.tenantId, input.code],
    );
    if (taken)
      throw new ConflictError('BARCODE_IN_USE', `Barcode ${input.code} is already assigned`, {
        variantId: taken.variant_id,
      });
    if (input.isPrimary)
      await uow.db.query(
        'UPDATE catalog.barcodes SET is_primary = false WHERE tenant_id = $1 AND variant_id = $2 AND is_primary',
        [uow.tenantId, variant.id],
      );
    const id = newId();
    const rows = await uow.db.query<BarcodeRow>(
      `INSERT INTO catalog.barcodes (id, tenant_id, variant_id, code, kind, pack_quantity, is_primary)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'ean13'), COALESCE($6::numeric, 1), COALESCE($7, false)) RETURNING *`,
      [
        id,
        uow.tenantId,
        variant.id,
        input.code,
        input.kind ?? null,
        input.packQuantity ?? null,
        input.isPrimary ?? null,
      ],
    );
    const created = toBarcodeDto(rows[0]!);
    uow.audit({
      action: 'catalog.barcode.created',
      resourceKind: 'barcode',
      resourceId: id,
      after: created,
    });
    emitCatalogChanged(uow, {
      entity: 'barcode',
      entityId: id,
      change: 'created',
      itemId: variant.itemId,
    });
    return created;
  }

  async deleteBarcode(id: string): Promise<void> {
    await this.authz.assert('catalog.item.manage');
    await this.uow.run(async (uow) => {
      const rows = await uow.db.query<BarcodeRow>(
        'DELETE FROM catalog.barcodes WHERE tenant_id = $1 AND id = $2 RETURNING *',
        [uow.tenantId, id],
      );
      if (rows.length === 0) throw new NotFoundError();
      const before = toBarcodeDto(rows[0]!);
      const variant = await this.requireVariant(uow.db, before.variantId);
      uow.audit({
        action: 'catalog.barcode.deleted',
        resourceKind: 'barcode',
        resourceId: id,
        before,
      });
      emitCatalogChanged(uow, {
        entity: 'barcode',
        entityId: id,
        change: 'deleted',
        itemId: variant.itemId,
      });
      await this.bumpItem(uow, variant.itemId);
    });
  }

  // -------------------------------------------------------------- lookups

  /** Scan path: one indexed hit on (tenant_id, code). */
  async lookupByBarcode(code: string): Promise<VariantLookupDto> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read(async (db) => {
      const barcode = await db.maybeOne<BarcodeRow>(
        'SELECT * FROM catalog.barcodes WHERE tenant_id = $1 AND code = $2',
        [db.tenantId, code],
      );
      if (!barcode) throw new NotFoundError();
      return this.lookup(db, barcode.variant_id, toBarcodeDto(barcode));
    });
  }

  async lookupBySku(sku: string): Promise<VariantLookupDto> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read(async (db) => {
      const variant = await db.maybeOne<{ id: string }>(
        'SELECT id FROM catalog.item_variants WHERE tenant_id = $1 AND sku = $2',
        [db.tenantId, sku],
      );
      if (!variant) throw new NotFoundError();
      return this.lookup(db, variant.id, null);
    });
  }

  /**
   * Fuzzy product search: full text over the maintained search_vector (name, SKUs, barcodes,
   * description) OR trigram similarity on the name for misspellings, ranked by the better signal.
   */
  async search(query: ItemSearchQuery): Promise<ItemSearchResultDto> {
    this.authz.assertAnywhere('catalog.view');
    const q = query.q.trim();
    return this.uow.read(async (db) => {
      // The function is tenant-pinned (platform.current_tenant()) and SECURITY DEFINER so the GIN indexes are usable
      // under row level security (migration 0003 §E); the join back to items is RLS-checked as usual.
      const rows = await db.query<SearchRow>(
        `SELECT i.*, f.text_rank, f.similarity
         FROM catalog.fn_search_items($2, $3, $4, $5, ${FUZZY_THRESHOLD}) f
         JOIN catalog.items i ON i.tenant_id = $1 AND i.id = f.id
         ORDER BY f.score DESC, i.name, i.id`,
        [db.tenantId, q, query.limit, query.kind ?? null, query.status ?? null],
      );
      return {
        query: q,
        hits: rows.map((r) => {
          const text = Number(r.text_rank);
          const fuzzy = Number(r.similarity);
          return {
            item: toItemDto(r),
            score: Math.max(Math.min(text, 1), fuzzy),
            matchedBy: text > 0 && fuzzy >= FUZZY_THRESHOLD ? 'both' : text > 0 ? 'text' : 'fuzzy',
          };
        }),
      };
    });
  }

  // -------------------------------------------------------------- helpers

  async requireItem(db: TenantScopedDb, id: string): Promise<ItemDto> {
    const row = await db.maybeOne<ItemRow>(
      'SELECT * FROM catalog.items WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, id],
    );
    if (!row) throw new NotFoundError();
    return toItemDto(row);
  }

  async requireVariant(db: TenantScopedDb, id: string): Promise<VariantDto> {
    const row = await db.maybeOne<VariantRow>(
      'SELECT * FROM catalog.item_variants WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, id],
    );
    if (!row) throw new NotFoundError();
    return toVariantDto(row);
  }

  async detail(db: TenantScopedDb, id: string): Promise<ItemDetailDto> {
    const item = await this.requireItem(db, id);
    // One client per transaction: queries must not overlap (pg 9 will reject it).
    const variants = await this.variantsOf(db, id);
    const links = await db.query<ItemModifierGroupRow>(
      'SELECT * FROM catalog.item_modifier_groups WHERE tenant_id = $1 AND item_id = $2 ORDER BY display_order, group_id',
      [db.tenantId, id],
    );
    return { ...item, variants, modifierGroups: links.map(toItemModifierGroupDto) };
  }

  async variantsOf(db: TenantScopedDb, itemId: string): Promise<VariantWithBarcodesDto[]> {
    const rows = await db.query<VariantRow>(
      'SELECT * FROM catalog.item_variants WHERE tenant_id = $1 AND item_id = $2 ORDER BY is_default DESC, id',
      [db.tenantId, itemId],
    );
    const barcodes = await this.barcodesOf(
      db,
      rows.map((r) => r.id),
    );
    return rows.map((r) => ({
      ...toVariantDto(r),
      barcodes: barcodes.filter((b) => b.variantId === r.id),
    }));
  }

  async barcodesOf(db: TenantScopedDb, variantIds: readonly string[]): Promise<BarcodeDto[]> {
    if (variantIds.length === 0) return [];
    const rows = await db.query<BarcodeRow>(
      'SELECT * FROM catalog.barcodes WHERE tenant_id = $1 AND variant_id = ANY($2::uuid[]) ORDER BY is_primary DESC, code',
      [db.tenantId, variantIds],
    );
    return rows.map(toBarcodeDto);
  }

  /** Child changes bump the item version so devices (and ETags) see the aggregate move. */
  async bumpItem(uow: TenantUnitOfWork, itemId: string): Promise<number> {
    const rows = await uow.db.query<{ version: number }>(
      'UPDATE catalog.items SET version = version + 1, updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING version',
      [uow.tenantId, itemId],
    );
    return rows[0]?.version ?? 0;
  }

  private async clearDefault(db: TenantScopedDb, itemId: string): Promise<void> {
    await db.query(
      'UPDATE catalog.item_variants SET is_default = false WHERE tenant_id = $1 AND item_id = $2 AND is_default',
      [db.tenantId, itemId],
    );
  }

  private async lookup(
    db: TenantScopedDb,
    variantId: string,
    barcode: BarcodeDto | null,
  ): Promise<VariantLookupDto> {
    const variant = await this.requireVariant(db, variantId);
    const item = await this.requireItem(db, variant.itemId);
    return {
      variant: { ...variant, barcodes: await this.barcodesOf(db, [variantId]) },
      item,
      barcode,
    };
  }
}
