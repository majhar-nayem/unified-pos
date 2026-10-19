import { Injectable } from '@nestjs/common';
import type {
  CreateItemComponent,
  ItemComponentDto,
  RecipeDto,
  UpdateItemComponent,
} from '@pos/contracts';
import { newId } from '@pos/db';

import {
  AuthorizationService,
  ConflictError,
  NotFoundError,
  UnitOfWork,
} from '../../kernel/public/index.js';
import { type ComponentRow, type RecipeRow, toComponentDto, toRecipeDto } from '../rows.js';
import { emitCatalogChanged } from '../shared/events.js';
import { buildPatch } from '../shared/sql.js';
import { ItemsService } from './items.service.js';

const COLUMNS = {
  quantity: 'quantity',
  componentGroup: 'component_group',
  isOptional: 'is_optional',
  priceDeltaMinor: 'price_delta_minor',
  displayOrder: 'display_order',
} as const;

/** Bundles, kits and combos (catalog.item_components) plus the read-only recipe stub (M10). */
@Injectable()
export class ComponentsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly items: ItemsService,
  ) {}

  async list(parentVariantId: string): Promise<ItemComponentDto[]> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read(async (db) => {
      await this.items.requireVariant(db, parentVariantId);
      const rows = await db.query<ComponentRow>(
        'SELECT * FROM catalog.item_components WHERE tenant_id = $1 AND parent_variant_id = $2 ORDER BY display_order, id',
        [db.tenantId, parentVariantId],
      );
      return rows.map(toComponentDto);
    });
  }

  async create(parentVariantId: string, input: CreateItemComponent): Promise<ItemComponentDto> {
    await this.authz.assert('catalog.item.manage');
    return this.uow.run(async (uow) => {
      const parent = await this.items.requireVariant(uow.db, parentVariantId);
      if (input.childVariantId === parentVariantId)
        throw new ConflictError('COMPONENT_SELF', 'A variant cannot be a component of itself');
      await this.items.requireVariant(uow.db, input.childVariantId);
      const id = newId();
      const rows = await uow.db.query<ComponentRow>(
        `INSERT INTO catalog.item_components (id, tenant_id, parent_variant_id, child_variant_id, quantity, component_group, is_optional, price_delta_minor, display_order)
         VALUES ($1, $2, $3, $4, COALESCE($5::numeric, 1), $6, COALESCE($7, false), COALESCE($8::bigint, 0), COALESCE($9, 0)) RETURNING *`,
        [
          id,
          uow.tenantId,
          parentVariantId,
          input.childVariantId,
          input.quantity ?? null,
          input.componentGroup ?? null,
          input.isOptional ?? null,
          input.priceDeltaMinor ?? null,
          input.displayOrder ?? null,
        ],
      );
      const created = toComponentDto(rows[0]!);
      uow.audit({
        action: 'catalog.component.created',
        resourceKind: 'item_component',
        resourceId: id,
        after: created,
      });
      emitCatalogChanged(uow, {
        entity: 'item_component',
        entityId: id,
        change: 'created',
        itemId: parent.itemId,
      });
      await this.items.bumpItem(uow, parent.itemId);
      return created;
    });
  }

  async update(id: string, patch: UpdateItemComponent): Promise<ItemComponentDto> {
    await this.authz.assert('catalog.item.manage');
    return this.uow.run(async (uow) => {
      const before = await this.require(uow, id);
      const { set, params } = buildPatch(patch, COLUMNS, 3);
      if (!set) return before;
      const rows = await uow.db.query<ComponentRow>(
        `UPDATE catalog.item_components SET ${set} WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [uow.tenantId, id, ...params],
      );
      const after = toComponentDto(rows[0]!);
      const parent = await this.items.requireVariant(uow.db, after.parentVariantId);
      uow.audit({
        action: 'catalog.component.updated',
        resourceKind: 'item_component',
        resourceId: id,
        before,
        after,
      });
      emitCatalogChanged(uow, {
        entity: 'item_component',
        entityId: id,
        change: 'updated',
        itemId: parent.itemId,
      });
      await this.items.bumpItem(uow, parent.itemId);
      return after;
    });
  }

  async delete(id: string): Promise<void> {
    await this.authz.assert('catalog.item.manage');
    await this.uow.run(async (uow) => {
      const rows = await uow.db.query<ComponentRow>(
        'DELETE FROM catalog.item_components WHERE tenant_id = $1 AND id = $2 RETURNING *',
        [uow.tenantId, id],
      );
      if (rows.length === 0) throw new NotFoundError();
      const before = toComponentDto(rows[0]!);
      const parent = await this.items.requireVariant(uow.db, before.parentVariantId);
      uow.audit({
        action: 'catalog.component.deleted',
        resourceKind: 'item_component',
        resourceId: id,
        before,
      });
      emitCatalogChanged(uow, {
        entity: 'item_component',
        entityId: id,
        change: 'deleted',
        itemId: parent.itemId,
      });
      await this.items.bumpItem(uow, parent.itemId);
    });
  }

  /** Read-only until M10 (recipes and consumption). */
  async listRecipes(outputVariantId: string): Promise<RecipeDto[]> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read(async (db) => {
      await this.items.requireVariant(db, outputVariantId);
      const rows = await db.query<RecipeRow>(
        'SELECT * FROM catalog.recipes WHERE tenant_id = $1 AND output_variant_id = $2 ORDER BY version DESC',
        [db.tenantId, outputVariantId],
      );
      return rows.map(toRecipeDto);
    });
  }

  private async require(
    uow: { db: import('@pos/db').TenantScopedDb },
    id: string,
  ): Promise<ItemComponentDto> {
    const row = await uow.db.maybeOne<ComponentRow>(
      'SELECT * FROM catalog.item_components WHERE tenant_id = $1 AND id = $2',
      [uow.db.tenantId, id],
    );
    if (!row) throw new NotFoundError();
    return toComponentDto(row);
  }
}
