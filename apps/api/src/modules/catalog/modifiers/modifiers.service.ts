import { Injectable } from '@nestjs/common';
import type {
  CreateModifier,
  CreateModifierGroup,
  CursorQuery,
  ItemModifierGroupLinkDto,
  LinkModifierGroup,
  ModifierDto,
  ModifierGroupDetailDto,
  ModifierGroupDto,
  ModifierValidationDto,
  Page,
  UpdateModifier,
  UpdateModifierGroup,
  ValidateModifierSelection,
} from '@pos/contracts';
import { newId, type TenantScopedDb, type TenantUnitOfWork } from '@pos/db';
import { type LinkedModifierGroup, validateModifierSelection } from '@pos/domain-core';

import {
  AuthorizationService,
  NotFoundError,
  UnitOfWork,
  VersionConflictError,
} from '../../kernel/public/index.js';
import { ItemsService } from '../items/items.service.js';
import {
  type ItemModifierGroupRow,
  type ModifierGroupRow,
  type ModifierRow,
  toItemModifierGroupDto,
  toModifierDto,
  toModifierGroupDto,
} from '../rows.js';
import { emitCatalogChanged } from '../shared/events.js';
import { buildPatch, queryPage } from '../shared/sql.js';

const GROUP_COLUMNS = {
  name: 'name',
  prompt: 'prompt',
  selectionMin: 'selection_min',
  selectionMax: 'selection_max',
  allowRepeat: 'allow_repeat',
  displayOrder: 'display_order',
  status: 'status',
} as const;

const MODIFIER_COLUMNS = {
  name: 'name',
  kind: 'kind',
  priceDeltaMinor: 'price_delta_minor',
  linkedVariantId: 'linked_variant_id',
  isDefault: 'is_default',
  maxQuantity: 'max_quantity',
  kitchenLabel: 'kitchen_label',
  displayOrder: 'display_order',
  status: 'status',
} as const;

@Injectable()
export class ModifiersService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly items: ItemsService,
  ) {}

  async listGroups(query: CursorQuery & { status?: string }): Promise<Page<ModifierGroupDto>> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read((db) =>
      queryPage<ModifierGroupRow, ModifierGroupDto>(
        db,
        {
          from: 'catalog.modifier_groups t',
          where: query.status ? [{ sql: 't.status = ?', value: query.status }] : [],
          cursor: query.cursor,
          limit: query.limit,
        },
        toModifierGroupDto,
      ),
    );
  }

  async getGroup(id: string): Promise<ModifierGroupDetailDto> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read((db) => this.detail(db, id));
  }

  async createGroup(input: CreateModifierGroup): Promise<ModifierGroupDetailDto> {
    await this.authz.assert('catalog.modifier.manage');
    return this.uow.run(async (uow) => {
      const id = newId();
      const rows = await uow.db.query<ModifierGroupRow>(
        `INSERT INTO catalog.modifier_groups (id, tenant_id, name, prompt, selection_min, selection_max, allow_repeat, display_order)
         VALUES ($1, $2, $3, $4, COALESCE($5, 0), $6, COALESCE($7, false), COALESCE($8, 0)) RETURNING *`,
        [
          id,
          uow.tenantId,
          input.name,
          input.prompt ?? null,
          input.selectionMin ?? null,
          input.selectionMax ?? null,
          input.allowRepeat ?? null,
          input.displayOrder ?? null,
        ],
      );
      const created = toModifierGroupDto(rows[0]!);
      uow.audit({
        action: 'catalog.modifier_group.created',
        resourceKind: 'modifier_group',
        resourceId: id,
        after: created,
      });
      emitCatalogChanged(uow, {
        entity: 'modifier_group',
        entityId: id,
        change: 'created',
        version: 1,
      });
      for (const modifier of input.modifiers ?? [])
        await this.insertModifier(uow, created, modifier);
      return this.detail(uow.db, id);
    });
  }

  async updateGroup(
    id: string,
    patch: UpdateModifierGroup,
    expectedVersion: number,
  ): Promise<ModifierGroupDetailDto> {
    await this.authz.assert('catalog.modifier.manage');
    return this.uow.run(async (uow) => {
      const before = await this.requireGroup(uow.db, id);
      const { set, params } = buildPatch(patch, GROUP_COLUMNS, 3);
      if (!set) {
        if (before.version !== expectedVersion)
          throw new VersionConflictError(expectedVersion, before.version);
        return this.detail(uow.db, id);
      }
      const rows = await uow.db.query<ModifierGroupRow>(
        `UPDATE catalog.modifier_groups SET ${set}, version = version + 1, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND version = ${expectedVersion} RETURNING *`,
        [uow.tenantId, id, ...params],
      );
      if (rows.length === 0) throw new VersionConflictError(expectedVersion, before.version);
      const after = toModifierGroupDto(rows[0]!);
      uow.audit({
        action: 'catalog.modifier_group.updated',
        resourceKind: 'modifier_group',
        resourceId: id,
        before,
        after,
      });
      emitCatalogChanged(uow, {
        entity: 'modifier_group',
        entityId: id,
        change: 'updated',
        version: after.version,
      });
      return this.detail(uow.db, id);
    });
  }

  async createModifier(groupId: string, input: CreateModifier): Promise<ModifierDto> {
    await this.authz.assert('catalog.modifier.manage');
    return this.uow.run(async (uow) => {
      const group = await this.requireGroup(uow.db, groupId);
      const created = await this.insertModifier(uow, group, input);
      await this.bumpGroup(uow, groupId);
      return created;
    });
  }

  private async insertModifier(
    uow: TenantUnitOfWork,
    group: ModifierGroupDto,
    input: CreateModifier,
  ): Promise<ModifierDto> {
    if (input.linkedVariantId) await this.items.requireVariant(uow.db, input.linkedVariantId);
    const id = newId();
    const rows = await uow.db.query<ModifierRow>(
      `INSERT INTO catalog.modifiers (id, tenant_id, group_id, name, kind, price_delta_minor, linked_variant_id, is_default, max_quantity, kitchen_label, display_order)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'add'), COALESCE($6::bigint, 0), $7, COALESCE($8, false), COALESCE($9, 1), $10, COALESCE($11, 0)) RETURNING *`,
      [
        id,
        uow.tenantId,
        group.id,
        input.name,
        input.kind ?? null,
        input.priceDeltaMinor ?? null,
        input.linkedVariantId ?? null,
        input.isDefault ?? null,
        input.maxQuantity ?? null,
        input.kitchenLabel ?? null,
        input.displayOrder ?? null,
      ],
    );
    const created = toModifierDto(rows[0]!);
    uow.audit({
      action: 'catalog.modifier.created',
      resourceKind: 'modifier',
      resourceId: id,
      after: created,
    });
    emitCatalogChanged(uow, {
      entity: 'modifier',
      entityId: id,
      change: 'created',
      detail: { groupId: group.id },
    });
    return created;
  }

  async updateModifier(id: string, patch: UpdateModifier): Promise<ModifierDto> {
    await this.authz.assert('catalog.modifier.manage');
    return this.uow.run(async (uow) => {
      const before = await this.requireModifier(uow.db, id);
      if (patch.linkedVariantId) await this.items.requireVariant(uow.db, patch.linkedVariantId);
      const { set, params } = buildPatch(patch, MODIFIER_COLUMNS, 3);
      if (!set) return before;
      const rows = await uow.db.query<ModifierRow>(
        `UPDATE catalog.modifiers SET ${set} WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [uow.tenantId, id, ...params],
      );
      const after = toModifierDto(rows[0]!);
      uow.audit({
        action: 'catalog.modifier.updated',
        resourceKind: 'modifier',
        resourceId: id,
        before,
        after,
      });
      emitCatalogChanged(uow, {
        entity: 'modifier',
        entityId: id,
        change: 'updated',
        detail: { groupId: after.groupId },
      });
      await this.bumpGroup(uow, after.groupId);
      return after;
    });
  }

  async deleteModifier(id: string): Promise<void> {
    await this.authz.assert('catalog.modifier.manage');
    await this.uow.run(async (uow) => {
      const rows = await uow.db.query<ModifierRow>(
        'DELETE FROM catalog.modifiers WHERE tenant_id = $1 AND id = $2 RETURNING *',
        [uow.tenantId, id],
      );
      if (rows.length === 0) throw new NotFoundError();
      const before = toModifierDto(rows[0]!);
      uow.audit({
        action: 'catalog.modifier.deleted',
        resourceKind: 'modifier',
        resourceId: id,
        before,
      });
      emitCatalogChanged(uow, {
        entity: 'modifier',
        entityId: id,
        change: 'deleted',
        detail: { groupId: before.groupId },
      });
      await this.bumpGroup(uow, before.groupId);
    });
  }

  // ------------------------------------------------------------ item links

  async listLinks(itemId: string): Promise<ModifierGroupDetailDto[]> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read(async (db) => {
      await this.items.requireItem(db, itemId);
      return this.linkedGroups(db, itemId).then((groups) => groups.map((g) => g.detail));
    });
  }

  async link(
    itemId: string,
    groupId: string,
    input: LinkModifierGroup,
  ): Promise<ItemModifierGroupLinkDto> {
    await this.authz.assert('catalog.modifier.manage');
    return this.uow.run(async (uow) => {
      await this.items.requireItem(uow.db, itemId);
      await this.requireGroup(uow.db, groupId);
      const rows = await uow.db.query<ItemModifierGroupRow>(
        `INSERT INTO catalog.item_modifier_groups (tenant_id, item_id, group_id, display_order, overrides)
         VALUES ($1, $2, $3, COALESCE($4, 0), COALESCE($5::jsonb, '{}'::jsonb))
         ON CONFLICT (item_id, group_id) DO UPDATE SET display_order = COALESCE($4, catalog.item_modifier_groups.display_order),
           overrides = COALESCE($5::jsonb, catalog.item_modifier_groups.overrides)
         RETURNING *`,
        [
          uow.tenantId,
          itemId,
          groupId,
          input.displayOrder ?? null,
          input.overrides ? JSON.stringify(input.overrides) : null,
        ],
      );
      const link = toItemModifierGroupDto(rows[0]!);
      uow.audit({
        action: 'catalog.item_modifier_group.linked',
        resourceKind: 'item',
        resourceId: itemId,
        after: link,
      });
      emitCatalogChanged(uow, {
        entity: 'item_modifier_group',
        entityId: groupId,
        change: 'updated',
        itemId,
      });
      await this.items.bumpItem(uow, itemId);
      return link;
    });
  }

  async unlink(itemId: string, groupId: string): Promise<void> {
    await this.authz.assert('catalog.modifier.manage');
    await this.uow.run(async (uow) => {
      const rows = await uow.db.query<ItemModifierGroupRow>(
        'DELETE FROM catalog.item_modifier_groups WHERE tenant_id = $1 AND item_id = $2 AND group_id = $3 RETURNING *',
        [uow.tenantId, itemId, groupId],
      );
      if (rows.length === 0) throw new NotFoundError();
      uow.audit({
        action: 'catalog.item_modifier_group.unlinked',
        resourceKind: 'item',
        resourceId: itemId,
        before: toItemModifierGroupDto(rows[0]!),
      });
      emitCatalogChanged(uow, {
        entity: 'item_modifier_group',
        entityId: groupId,
        change: 'deleted',
        itemId,
      });
      await this.items.bumpItem(uow, itemId);
    });
  }

  /** Same evaluator the POS runs offline (@pos/domain-core validateModifierSelection). */
  async validate(itemId: string, input: ValidateModifierSelection): Promise<ModifierValidationDto> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read(async (db) => {
      await this.items.requireItem(db, itemId);
      const groups = await this.linkedGroups(db, itemId);
      const result = validateModifierSelection(
        groups.map((g) => g.spec),
        input.selections,
      );
      return {
        valid: result.valid,
        issues: [...result.issues],
        priceDeltaMinor: result.priceDeltaMinor.toString(),
        selections: result.selections.map((s) => ({
          groupId: s.groupId,
          modifierId: s.modifierId,
          quantity: s.quantity,
          unitPriceDeltaMinor: s.unitPriceDeltaMinor.toString(),
        })),
      };
    });
  }

  // --------------------------------------------------------------- helpers

  private async linkedGroups(
    db: TenantScopedDb,
    itemId: string,
  ): Promise<Array<{ detail: ModifierGroupDetailDto; spec: LinkedModifierGroup }>> {
    const links = await db.query<ItemModifierGroupRow>(
      'SELECT * FROM catalog.item_modifier_groups WHERE tenant_id = $1 AND item_id = $2 ORDER BY display_order, group_id',
      [db.tenantId, itemId],
    );
    const out = [];
    for (const link of links) {
      const detail = await this.detail(db, link.group_id);
      out.push({
        detail,
        spec: {
          id: detail.id,
          status: detail.status,
          selectionMin: detail.selectionMin,
          selectionMax: detail.selectionMax,
          allowRepeat: detail.allowRepeat,
          modifiers: detail.modifiers.map((m) => ({
            id: m.id,
            status: m.status,
            maxQuantity: m.maxQuantity,
            priceDeltaMinor: m.priceDeltaMinor,
          })),
          overrides: link.overrides ?? {},
        },
      });
    }
    return out;
  }

  async requireGroup(db: TenantScopedDb, id: string): Promise<ModifierGroupDto> {
    const row = await db.maybeOne<ModifierGroupRow>(
      'SELECT * FROM catalog.modifier_groups WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, id],
    );
    if (!row) throw new NotFoundError();
    return toModifierGroupDto(row);
  }

  private async requireModifier(db: TenantScopedDb, id: string): Promise<ModifierDto> {
    const row = await db.maybeOne<ModifierRow>(
      'SELECT * FROM catalog.modifiers WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, id],
    );
    if (!row) throw new NotFoundError();
    return toModifierDto(row);
  }

  private async detail(db: TenantScopedDb, id: string): Promise<ModifierGroupDetailDto> {
    const group = await this.requireGroup(db, id);
    const modifiers = await db.query<ModifierRow>(
      'SELECT * FROM catalog.modifiers WHERE tenant_id = $1 AND group_id = $2 ORDER BY display_order, id',
      [db.tenantId, id],
    );
    return { ...group, modifiers: modifiers.map(toModifierDto) };
  }

  private async bumpGroup(uow: TenantUnitOfWork, groupId: string): Promise<void> {
    await uow.db.query(
      'UPDATE catalog.modifier_groups SET version = version + 1, updated_at = now() WHERE tenant_id = $1 AND id = $2',
      [uow.tenantId, groupId],
    );
  }
}
