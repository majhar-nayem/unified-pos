import { Injectable } from '@nestjs/common';
import type {
  CreateSupplier,
  CreateSupplierItem,
  CursorQuery,
  Page,
  SupplierDto,
  SupplierItemDto,
  UpdateSupplier,
  UpdateSupplierItem,
} from '@pos/contracts';
import { newId, type TenantScopedDb, type TenantUnitOfWork } from '@pos/db';

import {
  AuthorizationService,
  NotFoundError,
  UnitOfWork,
  VersionConflictError,
} from '../../kernel/public/index.js';
import { ItemsService } from '../items/items.service.js';
import {
  type SupplierItemRow,
  type SupplierRow,
  toSupplierDto,
  toSupplierItemDto,
} from '../rows.js';
import { emitCatalogChanged } from '../shared/events.js';
import { buildPatch, queryPage } from '../shared/sql.js';

const SUPPLIER_COLUMNS = {
  code: 'code',
  name: 'name',
  contacts: { column: 'contacts', json: true },
  paymentTerms: 'payment_terms',
  leadTimeDays: 'lead_time_days',
  minOrderMinor: 'min_order_minor',
  currency: 'currency',
  status: 'status',
} as const;

const SUPPLIER_ITEM_COLUMNS = {
  supplierSku: 'supplier_sku',
  costMinor: 'cost_minor',
  currency: 'currency',
  packSize: 'pack_size',
  purchaseUnit: 'purchase_unit',
  moq: 'moq',
  leadTimeDays: 'lead_time_days',
  isPreferred: 'is_preferred',
  validFrom: 'valid_from',
  validTo: 'valid_to',
} as const;

@Injectable()
export class SuppliersService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly items: ItemsService,
  ) {}

  async list(query: CursorQuery & { status?: string }): Promise<Page<SupplierDto>> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read((db) =>
      queryPage<SupplierRow, SupplierDto>(
        db,
        {
          from: 'catalog.suppliers t',
          where: query.status ? [{ sql: 't.status = ?', value: query.status }] : [],
          cursor: query.cursor,
          limit: query.limit,
        },
        toSupplierDto,
      ),
    );
  }

  async get(id: string): Promise<SupplierDto> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read((db) => this.require(db, id));
  }

  async create(input: CreateSupplier): Promise<SupplierDto> {
    await this.authz.assert('catalog.supplier.manage');
    return this.uow.run(async (uow) => {
      const id = newId();
      const rows = await uow.db.query<SupplierRow>(
        `INSERT INTO catalog.suppliers (id, tenant_id, code, name, contacts, payment_terms, lead_time_days, min_order_minor, currency)
         VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '[]'::jsonb), $6, $7, $8, $9) RETURNING *`,
        [
          id,
          uow.tenantId,
          input.code ?? null,
          input.name,
          input.contacts ? JSON.stringify(input.contacts) : null,
          input.paymentTerms ?? null,
          input.leadTimeDays ?? null,
          input.minOrderMinor ?? null,
          input.currency ?? null,
        ],
      );
      const created = toSupplierDto(rows[0]!);
      uow.audit({
        action: 'catalog.supplier.created',
        resourceKind: 'supplier',
        resourceId: id,
        after: created,
      });
      emitCatalogChanged(uow, { entity: 'supplier', entityId: id, change: 'created', version: 1 });
      return created;
    });
  }

  async update(id: string, patch: UpdateSupplier, expectedVersion: number): Promise<SupplierDto> {
    await this.authz.assert('catalog.supplier.manage');
    return this.uow.run(async (uow) => {
      const before = await this.require(uow.db, id);
      const { set, params } = buildPatch(patch, SUPPLIER_COLUMNS, 3);
      if (!set) {
        if (before.version !== expectedVersion)
          throw new VersionConflictError(expectedVersion, before.version);
        return before;
      }
      const rows = await uow.db.query<SupplierRow>(
        `UPDATE catalog.suppliers SET ${set}, version = version + 1, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND version = ${expectedVersion} RETURNING *`,
        [uow.tenantId, id, ...params],
      );
      if (rows.length === 0) throw new VersionConflictError(expectedVersion, before.version);
      const after = toSupplierDto(rows[0]!);
      uow.audit({
        action: 'catalog.supplier.updated',
        resourceKind: 'supplier',
        resourceId: id,
        before,
        after,
      });
      emitCatalogChanged(uow, {
        entity: 'supplier',
        entityId: id,
        change: 'updated',
        version: after.version,
      });
      return after;
    });
  }

  async listItems(supplierId: string): Promise<SupplierItemDto[]> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read(async (db) => {
      await this.require(db, supplierId);
      const rows = await db.query<SupplierItemRow>(
        'SELECT * FROM catalog.supplier_items WHERE tenant_id = $1 AND supplier_id = $2 ORDER BY id',
        [db.tenantId, supplierId],
      );
      return rows.map(toSupplierItemDto);
    });
  }

  async createItem(supplierId: string, input: CreateSupplierItem): Promise<SupplierItemDto> {
    await this.authz.assert('catalog.supplier.manage');
    return this.uow.run(async (uow) => {
      await this.require(uow.db, supplierId);
      const variant = await this.items.requireVariant(uow.db, input.variantId);
      const id = newId();
      const rows = await uow.db.query<SupplierItemRow>(
        `INSERT INTO catalog.supplier_items (id, tenant_id, supplier_id, variant_id, supplier_sku, cost_minor, currency, pack_size, purchase_unit, moq, lead_time_days, is_preferred, valid_from, valid_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::numeric, 1), COALESCE($9, 'each'), $10, $11, COALESCE($12, false), $13, $14) RETURNING *`,
        [
          id,
          uow.tenantId,
          supplierId,
          input.variantId,
          input.supplierSku ?? null,
          input.costMinor,
          input.currency,
          input.packSize ?? null,
          input.purchaseUnit ?? null,
          input.moq ?? null,
          input.leadTimeDays ?? null,
          input.isPreferred ?? null,
          input.validFrom ?? null,
          input.validTo ?? null,
        ],
      );
      const created = toSupplierItemDto(rows[0]!);
      uow.audit({
        action: 'catalog.supplier_item.created',
        resourceKind: 'supplier_item',
        resourceId: id,
        after: created,
      });
      emitCatalogChanged(uow, {
        entity: 'supplier_item',
        entityId: id,
        change: 'created',
        itemId: variant.itemId,
      });
      await this.bump(uow, supplierId);
      return created;
    });
  }

  async updateItem(id: string, patch: UpdateSupplierItem): Promise<SupplierItemDto> {
    await this.authz.assert('catalog.supplier.manage');
    return this.uow.run(async (uow) => {
      const before = await this.requireItem(uow.db, id);
      const { set, params } = buildPatch(patch, SUPPLIER_ITEM_COLUMNS, 3);
      if (!set) return before;
      const rows = await uow.db.query<SupplierItemRow>(
        `UPDATE catalog.supplier_items SET ${set} WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [uow.tenantId, id, ...params],
      );
      const after = toSupplierItemDto(rows[0]!);
      uow.audit({
        action: 'catalog.supplier_item.updated',
        resourceKind: 'supplier_item',
        resourceId: id,
        before,
        after,
      });
      emitCatalogChanged(uow, { entity: 'supplier_item', entityId: id, change: 'updated' });
      await this.bump(uow, after.supplierId);
      return after;
    });
  }

  async deleteItem(id: string): Promise<void> {
    await this.authz.assert('catalog.supplier.manage');
    await this.uow.run(async (uow) => {
      const rows = await uow.db.query<SupplierItemRow>(
        'DELETE FROM catalog.supplier_items WHERE tenant_id = $1 AND id = $2 RETURNING *',
        [uow.tenantId, id],
      );
      if (rows.length === 0) throw new NotFoundError();
      const before = toSupplierItemDto(rows[0]!);
      uow.audit({
        action: 'catalog.supplier_item.deleted',
        resourceKind: 'supplier_item',
        resourceId: id,
        before,
      });
      emitCatalogChanged(uow, { entity: 'supplier_item', entityId: id, change: 'deleted' });
      await this.bump(uow, before.supplierId);
    });
  }

  private async require(db: TenantScopedDb, id: string): Promise<SupplierDto> {
    const row = await db.maybeOne<SupplierRow>(
      'SELECT * FROM catalog.suppliers WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, id],
    );
    if (!row) throw new NotFoundError();
    return toSupplierDto(row);
  }

  private async requireItem(db: TenantScopedDb, id: string): Promise<SupplierItemDto> {
    const row = await db.maybeOne<SupplierItemRow>(
      'SELECT * FROM catalog.supplier_items WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, id],
    );
    if (!row) throw new NotFoundError();
    return toSupplierItemDto(row);
  }

  private async bump(uow: TenantUnitOfWork, supplierId: string): Promise<void> {
    await uow.db.query(
      'UPDATE catalog.suppliers SET version = version + 1, updated_at = now() WHERE tenant_id = $1 AND id = $2',
      [uow.tenantId, supplierId],
    );
  }
}
