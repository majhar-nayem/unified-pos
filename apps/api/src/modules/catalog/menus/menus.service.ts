import { Injectable } from '@nestjs/common';
import type {
  CreateMenu,
  CreateMenuAssignment,
  CreateMenuSection,
  CursorQuery,
  MenuAssignmentDto,
  MenuDto,
  MenuResolutionDto,
  MenuResolveQuery,
  MenuSectionDto,
  MenuSectionItemDto,
  MenuTreeDto,
  Page,
  PutMenuSectionItem,
  UpdateMenu,
  UpdateMenuAssignment,
  UpdateMenuSection,
} from '@pos/contracts';
import { newId, type TenantScopedDb } from '@pos/db';
import { type MenuAssignmentCandidate, type MenuScopeRef, resolveMenu } from '@pos/domain-core';

import {
  AuthorizationService,
  NotFoundError,
  UnitOfWork,
  VersionConflictError,
  ConflictError,
} from '../../kernel/public/index.js';
import { HierarchyService, scopePath } from '../../tenancy/public/index.js';
import { ItemsService } from '../items/items.service.js';
import {
  type MenuAssignmentRow,
  type MenuRow,
  type MenuSectionItemRow,
  type MenuSectionRow,
  toMenuAssignmentDto,
  toMenuDto,
  toMenuSectionDto,
  toMenuSectionItemDto,
} from '../rows.js';
import { emitCatalogChanged } from '../shared/events.js';
import { buildPatch, queryPage } from '../shared/sql.js';

const MENU_COLUMNS = { name: 'name', description: 'description', status: 'status' } as const;
const SECTION_COLUMNS = {
  parentSectionId: 'parent_section_id',
  name: 'name',
  displayOrder: 'display_order',
  layout: { column: 'layout', json: true },
} as const;
const ASSIGNMENT_COLUMNS = {
  scopeKind: 'scope_kind',
  scopeId: 'scope_id',
  channel: 'channel',
  schedule: { column: 'schedule', json: true },
  validFrom: 'valid_from',
  validTo: 'valid_to',
  priority: 'priority',
} as const;

interface CandidateRow extends MenuAssignmentRow {
  menu_status: string;
}

@Injectable()
export class MenusService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly items: ItemsService,
    private readonly hierarchy: HierarchyService,
  ) {}

  // ------------------------------------------------------------------ menus

  async list(query: CursorQuery & { status?: string }): Promise<Page<MenuDto>> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read((db) =>
      queryPage<MenuRow, MenuDto>(
        db,
        {
          from: 'catalog.menus t',
          where: query.status ? [{ sql: 't.status = ?', value: query.status }] : [],
          cursor: query.cursor,
          limit: query.limit,
        },
        toMenuDto,
      ),
    );
  }

  async get(id: string): Promise<MenuTreeDto> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read((db) => this.tree(db, id));
  }

  async create(input: CreateMenu): Promise<MenuDto> {
    await this.authz.assert('catalog.menu.manage');
    return this.uow.run(async (uow) => {
      const id = newId();
      const rows = await uow.db.query<MenuRow>(
        'INSERT INTO catalog.menus (id, tenant_id, name, description) VALUES ($1, $2, $3, $4) RETURNING *',
        [id, uow.tenantId, input.name, input.description ?? null],
      );
      const created = toMenuDto(rows[0]!);
      uow.audit({
        action: 'catalog.menu.created',
        resourceKind: 'menu',
        resourceId: id,
        after: created,
      });
      emitCatalogChanged(uow, { entity: 'menu', entityId: id, change: 'created', version: 1 });
      return created;
    });
  }

  async update(id: string, patch: UpdateMenu, expectedVersion: number): Promise<MenuDto> {
    await this.authz.assert('catalog.menu.manage');
    return this.uow.run(async (uow) => {
      const before = await this.requireMenu(uow.db, id);
      const { set, params } = buildPatch(patch, MENU_COLUMNS, 3);
      if (!set) {
        if (before.version !== expectedVersion)
          throw new VersionConflictError(expectedVersion, before.version);
        return before;
      }
      const rows = await uow.db.query<MenuRow>(
        `UPDATE catalog.menus SET ${set}, version = version + 1, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND version = ${expectedVersion} RETURNING *`,
        [uow.tenantId, id, ...params],
      );
      if (rows.length === 0) throw new VersionConflictError(expectedVersion, before.version);
      const after = toMenuDto(rows[0]!);
      uow.audit({
        action: 'catalog.menu.updated',
        resourceKind: 'menu',
        resourceId: id,
        before,
        after,
      });
      emitCatalogChanged(uow, {
        entity: 'menu',
        entityId: id,
        change: 'updated',
        version: after.version,
      });
      return after;
    });
  }

  /** Publish: status → published, version bumped (devices pull by version), `menu.published` emitted. */
  async publish(id: string, expectedVersion: number): Promise<MenuDto> {
    await this.authz.assert('catalog.menu.publish');
    return this.uow.run(async (uow) => {
      const before = await this.requireMenu(uow.db, id);
      const rows = await uow.db.query<MenuRow>(
        `UPDATE catalog.menus SET status = 'published', published_at = now(), version = version + 1, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND version = ${expectedVersion} AND status <> 'archived' RETURNING *`,
        [uow.tenantId, id],
      );
      if (rows.length === 0) {
        if (before.status === 'archived')
          throw new ConflictError('MENU_ARCHIVED', 'An archived menu cannot be published');
        throw new VersionConflictError(expectedVersion, before.version);
      }
      const after = toMenuDto(rows[0]!);
      uow.audit({
        action: 'catalog.menu.published',
        resourceKind: 'menu',
        resourceId: id,
        before,
        after,
      });
      uow.emit({
        type: 'menu.published',
        aggregateKind: 'menu',
        aggregateId: id,
        aggregateVersion: after.version,
        payload: {
          menuId: id,
          version: after.version,
          name: after.name,
          publishedAt: after.publishedAt,
        },
      });
      return after;
    });
  }

  // --------------------------------------------------------------- sections

  async createSection(menuId: string, input: CreateMenuSection): Promise<MenuSectionDto> {
    await this.authz.assert('catalog.menu.manage');
    return this.uow.run(async (uow) => {
      await this.requireMenu(uow.db, menuId);
      if (input.parentSectionId) {
        const parent = await this.requireSection(uow.db, input.parentSectionId);
        if (parent.menuId !== menuId) throw new NotFoundError();
      }
      const id = newId();
      const rows = await uow.db.query<MenuSectionRow>(
        `INSERT INTO catalog.menu_sections (id, tenant_id, menu_id, parent_section_id, name, display_order, layout)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, 0), COALESCE($7::jsonb, '{}'::jsonb)) RETURNING *`,
        [
          id,
          uow.tenantId,
          menuId,
          input.parentSectionId ?? null,
          input.name,
          input.displayOrder ?? null,
          input.layout ? JSON.stringify(input.layout) : null,
        ],
      );
      const created = toMenuSectionDto(rows[0]!);
      uow.audit({
        action: 'catalog.menu_section.created',
        resourceKind: 'menu_section',
        resourceId: id,
        after: created,
      });
      emitCatalogChanged(uow, {
        entity: 'menu_section',
        entityId: id,
        change: 'created',
        detail: { menuId },
      });
      return created;
    });
  }

  async updateSection(id: string, patch: UpdateMenuSection): Promise<MenuSectionDto> {
    await this.authz.assert('catalog.menu.manage');
    return this.uow.run(async (uow) => {
      const before = await this.requireSection(uow.db, id);
      if (patch.parentSectionId) {
        if (patch.parentSectionId === id)
          throw new ConflictError('SECTION_CYCLE', 'A section cannot be its own parent');
        const parent = await this.requireSection(uow.db, patch.parentSectionId);
        if (parent.menuId !== before.menuId) throw new NotFoundError();
      }
      const { set, params } = buildPatch(patch, SECTION_COLUMNS, 3);
      if (!set) return before;
      const rows = await uow.db.query<MenuSectionRow>(
        `UPDATE catalog.menu_sections SET ${set} WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [uow.tenantId, id, ...params],
      );
      const after = toMenuSectionDto(rows[0]!);
      uow.audit({
        action: 'catalog.menu_section.updated',
        resourceKind: 'menu_section',
        resourceId: id,
        before,
        after,
      });
      emitCatalogChanged(uow, {
        entity: 'menu_section',
        entityId: id,
        change: 'updated',
        detail: { menuId: after.menuId },
      });
      return after;
    });
  }

  async deleteSection(id: string): Promise<void> {
    await this.authz.assert('catalog.menu.manage');
    await this.uow.run(async (uow) => {
      const before = await this.requireSection(uow.db, id);
      const children = await uow.db.maybeOne<{ id: string }>(
        'SELECT id FROM catalog.menu_sections WHERE tenant_id = $1 AND parent_section_id = $2 LIMIT 1',
        [uow.tenantId, id],
      );
      if (children)
        throw new ConflictError('SECTION_HAS_CHILDREN', 'Delete or move the child sections first');
      await uow.db.query('DELETE FROM catalog.menu_sections WHERE tenant_id = $1 AND id = $2', [
        uow.tenantId,
        id,
      ]);
      uow.audit({
        action: 'catalog.menu_section.deleted',
        resourceKind: 'menu_section',
        resourceId: id,
        before,
      });
      emitCatalogChanged(uow, {
        entity: 'menu_section',
        entityId: id,
        change: 'deleted',
        detail: { menuId: before.menuId },
      });
    });
  }

  async putSectionItem(
    sectionId: string,
    itemId: string,
    input: PutMenuSectionItem,
  ): Promise<MenuSectionItemDto> {
    await this.authz.assert('catalog.menu.manage');
    return this.uow.run(async (uow) => {
      const section = await this.requireSection(uow.db, sectionId);
      await this.items.requireItem(uow.db, itemId);
      const rows = await uow.db.query<MenuSectionItemRow>(
        `INSERT INTO catalog.menu_section_items (tenant_id, section_id, item_id, display_order, price_override_minor, label_override)
         VALUES ($1, $2, $3, COALESCE($4, 0), $5, $6)
         ON CONFLICT (section_id, item_id) DO UPDATE SET
           display_order = COALESCE($4, catalog.menu_section_items.display_order),
           price_override_minor = CASE WHEN $7 THEN $5 ELSE catalog.menu_section_items.price_override_minor END,
           label_override = CASE WHEN $8 THEN $6 ELSE catalog.menu_section_items.label_override END
         RETURNING *`,
        [
          uow.tenantId,
          sectionId,
          itemId,
          input.displayOrder ?? null,
          input.priceOverrideMinor ?? null,
          input.labelOverride ?? null,
          input.priceOverrideMinor !== undefined,
          input.labelOverride !== undefined,
        ],
      );
      const saved = toMenuSectionItemDto(rows[0]!);
      uow.audit({
        action: 'catalog.menu_section_item.put',
        resourceKind: 'menu_section',
        resourceId: sectionId,
        after: saved,
      });
      emitCatalogChanged(uow, {
        entity: 'menu_section_item',
        entityId: sectionId,
        change: 'updated',
        itemId,
        detail: { menuId: section.menuId },
      });
      return saved;
    });
  }

  async deleteSectionItem(sectionId: string, itemId: string): Promise<void> {
    await this.authz.assert('catalog.menu.manage');
    await this.uow.run(async (uow) => {
      const section = await this.requireSection(uow.db, sectionId);
      const rows = await uow.db.query<MenuSectionItemRow>(
        'DELETE FROM catalog.menu_section_items WHERE tenant_id = $1 AND section_id = $2 AND item_id = $3 RETURNING *',
        [uow.tenantId, sectionId, itemId],
      );
      if (rows.length === 0) throw new NotFoundError();
      uow.audit({
        action: 'catalog.menu_section_item.removed',
        resourceKind: 'menu_section',
        resourceId: sectionId,
        before: toMenuSectionItemDto(rows[0]!),
      });
      emitCatalogChanged(uow, {
        entity: 'menu_section_item',
        entityId: sectionId,
        change: 'deleted',
        itemId,
        detail: { menuId: section.menuId },
      });
    });
  }

  // ------------------------------------------------------------ assignments

  async listAssignments(menuId: string): Promise<MenuAssignmentDto[]> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read(async (db) => {
      await this.requireMenu(db, menuId);
      const rows = await db.query<MenuAssignmentRow>(
        'SELECT * FROM catalog.menu_assignments WHERE tenant_id = $1 AND menu_id = $2 ORDER BY priority DESC, id',
        [db.tenantId, menuId],
      );
      return rows.map(toMenuAssignmentDto);
    });
  }

  /** Assigning a menu at a scope needs `catalog.menu.manage` *at that scope* (a store manager may assign at their store). */
  async createAssignment(menuId: string, input: CreateMenuAssignment): Promise<MenuAssignmentDto> {
    await this.assertAssignmentScope(input.scopeKind, input.scopeId);
    return this.uow.run(async (uow) => {
      await this.requireMenu(uow.db, menuId);
      await this.assertScopeExists(uow.db, input.scopeKind, input.scopeId);
      const id = newId();
      const rows = await uow.db.query<MenuAssignmentRow>(
        `INSERT INTO catalog.menu_assignments (id, tenant_id, menu_id, scope_kind, scope_id, channel, schedule, valid_from, valid_to, priority)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'all'), COALESCE($7::jsonb, '{}'::jsonb), $8, $9, COALESCE($10, 100)) RETURNING *`,
        [
          id,
          uow.tenantId,
          menuId,
          input.scopeKind,
          input.scopeId,
          input.channel ?? null,
          input.schedule ? JSON.stringify(input.schedule) : null,
          input.validFrom ?? null,
          input.validTo ?? null,
          input.priority ?? null,
        ],
      );
      const created = toMenuAssignmentDto(rows[0]!);
      uow.audit({
        action: 'catalog.menu_assignment.created',
        resourceKind: 'menu_assignment',
        resourceId: id,
        after: created,
        ...(input.scopeKind === 'location' ? { locationId: input.scopeId } : {}),
      });
      emitCatalogChanged(uow, {
        entity: 'menu_assignment',
        entityId: id,
        change: 'created',
        locationId: input.scopeKind === 'location' ? input.scopeId : null,
        detail: { menuId },
      });
      return created;
    });
  }

  async updateAssignment(id: string, patch: UpdateMenuAssignment): Promise<MenuAssignmentDto> {
    return this.uow.run(async (uow) => {
      const before = await this.requireAssignment(uow.db, id);
      await this.assertAssignmentScope(before.scopeKind, before.scopeId);
      const kind = patch.scopeKind ?? before.scopeKind;
      const scopeId = patch.scopeId ?? before.scopeId;
      if (patch.scopeKind !== undefined || patch.scopeId !== undefined) {
        await this.assertAssignmentScope(kind, scopeId);
        await this.assertScopeExists(uow.db, kind, scopeId);
      }
      const { set, params } = buildPatch(patch, ASSIGNMENT_COLUMNS, 3);
      if (!set) return before;
      const rows = await uow.db.query<MenuAssignmentRow>(
        `UPDATE catalog.menu_assignments SET ${set} WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [uow.tenantId, id, ...params],
      );
      const after = toMenuAssignmentDto(rows[0]!);
      uow.audit({
        action: 'catalog.menu_assignment.updated',
        resourceKind: 'menu_assignment',
        resourceId: id,
        before,
        after,
      });
      emitCatalogChanged(uow, {
        entity: 'menu_assignment',
        entityId: id,
        change: 'updated',
        detail: { menuId: after.menuId },
      });
      return after;
    });
  }

  async deleteAssignment(id: string): Promise<void> {
    await this.uow.run(async (uow) => {
      const before = await this.requireAssignment(uow.db, id);
      await this.assertAssignmentScope(before.scopeKind, before.scopeId);
      await uow.db.query('DELETE FROM catalog.menu_assignments WHERE tenant_id = $1 AND id = $2', [
        uow.tenantId,
        id,
      ]);
      uow.audit({
        action: 'catalog.menu_assignment.deleted',
        resourceKind: 'menu_assignment',
        resourceId: id,
        before,
      });
      emitCatalogChanged(uow, {
        entity: 'menu_assignment',
        entityId: id,
        change: 'deleted',
        detail: { menuId: before.menuId },
      });
    });
  }

  // ------------------------------------------------------------- resolution

  /**
   * Which menu applies at a location (and optionally a register) for a channel at an instant.
   * Eligible assignments are loaded for every scope on the location's path, then ranked by the
   * pure resolver in @pos/domain-core (the same code the POS runs offline).
   */
  async resolve(query: MenuResolveQuery): Promise<MenuResolutionDto> {
    await this.authz.assert('catalog.view', { kind: 'location', id: query.locationId });
    return this.uow.read(async (db) => {
      const location = await db.maybeOne<{ timezone: string }>(
        'SELECT timezone FROM tenancy.locations WHERE tenant_id = $1 AND id = $2',
        [db.tenantId, query.locationId],
      );
      if (!location) throw new NotFoundError();
      const path = query.registerId
        ? await scopePath(db, 'register', query.registerId)
        : await scopePath(db, 'location', query.locationId);
      if (!path || !path.path.some((s) => s.kind === 'location' && s.id === query.locationId))
        throw new NotFoundError();
      const scopePathRefs: MenuScopeRef[] = path.path
        .filter((s): s is typeof s & { kind: MenuScopeRef['kind'] } => s.kind !== 'department')
        .map((s) => ({ kind: s.kind, id: s.id }));
      const at = query.at ? new Date(query.at) : new Date();
      const rows = await db.query<CandidateRow>(
        `SELECT a.*, m.status AS menu_status
         FROM catalog.menu_assignments a JOIN catalog.menus m ON m.tenant_id = a.tenant_id AND m.id = a.menu_id
         WHERE a.tenant_id = $1 AND a.scope_id = ANY($2::uuid[])`,
        [db.tenantId, scopePathRefs.map((s) => s.id)],
      );
      const candidates = rows.map((r) => ({
        ...toMenuAssignmentDto(r),
        menuStatus: r.menu_status,
      }));
      const resolution = resolveMenu(
        candidates.map((c): MenuAssignmentCandidate & { dto: MenuAssignmentDto } => ({
          id: c.id,
          menuId: c.menuId,
          scopeKind: c.scopeKind,
          scopeId: c.scopeId,
          channel: c.channel,
          schedule: c.schedule,
          validFrom: c.validFrom,
          validTo: c.validTo,
          priority: c.priority,
          menuStatus: c.menuStatus,
          dto: c,
        })),
        { scopePath: scopePathRefs, channel: query.channel, at, timezone: location.timezone },
      );
      const winner = resolution.winner;
      return {
        locationId: query.locationId,
        channel: query.channel,
        at: at.toISOString(),
        timezone: location.timezone,
        localDate: resolution.local.date,
        localTime: resolution.local.time,
        weekday: resolution.local.weekday,
        assignment: winner ? winner.dto : null,
        menu: winner ? await this.tree(db, winner.menuId) : null,
        candidates: resolution.ranked.length,
      };
    });
  }

  // ---------------------------------------------------------------- helpers

  async tree(db: TenantScopedDb, id: string): Promise<MenuTreeDto> {
    const menu = await this.requireMenu(db, id);
    const sections = await db.query<MenuSectionRow>(
      'SELECT * FROM catalog.menu_sections WHERE tenant_id = $1 AND menu_id = $2 ORDER BY display_order, id',
      [db.tenantId, id],
    );
    const items = await db.query<MenuSectionItemRow>(
      `SELECT i.* FROM catalog.menu_section_items i JOIN catalog.menu_sections s ON s.tenant_id = i.tenant_id AND s.id = i.section_id
       WHERE i.tenant_id = $1 AND s.menu_id = $2 ORDER BY i.display_order, i.item_id`,
      [db.tenantId, id],
    );
    return {
      ...menu,
      sections: sections.map((s) => ({
        ...toMenuSectionDto(s),
        items: items.filter((i) => i.section_id === s.id).map(toMenuSectionItemDto),
      })),
    };
  }

  private async requireMenu(db: TenantScopedDb, id: string): Promise<MenuDto> {
    const row = await db.maybeOne<MenuRow>(
      'SELECT * FROM catalog.menus WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, id],
    );
    if (!row) throw new NotFoundError();
    return toMenuDto(row);
  }

  private async requireSection(db: TenantScopedDb, id: string): Promise<MenuSectionDto> {
    const row = await db.maybeOne<MenuSectionRow>(
      'SELECT * FROM catalog.menu_sections WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, id],
    );
    if (!row) throw new NotFoundError();
    return toMenuSectionDto(row);
  }

  private async requireAssignment(db: TenantScopedDb, id: string): Promise<MenuAssignmentDto> {
    const row = await db.maybeOne<MenuAssignmentRow>(
      'SELECT * FROM catalog.menu_assignments WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, id],
    );
    if (!row) throw new NotFoundError();
    return toMenuAssignmentDto(row);
  }

  private async assertAssignmentScope(
    kind: MenuAssignmentDto['scopeKind'],
    id: string,
  ): Promise<void> {
    await this.authz.assert('catalog.menu.manage', { kind, id });
  }

  /** menu_assignments.scope_id is polymorphic: nothing in the schema stops a dangling id, so check it here. */
  private async assertScopeExists(
    db: TenantScopedDb,
    kind: MenuAssignmentDto['scopeKind'],
    id: string,
  ): Promise<void> {
    await this.hierarchy.requireScope(db, kind, id);
  }
}
