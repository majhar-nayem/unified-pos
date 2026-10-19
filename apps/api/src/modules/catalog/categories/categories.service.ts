import { Injectable } from '@nestjs/common';
import type {
  CategoryDto,
  CategoryListQuery,
  CreateCategory,
  Page,
  UpdateCategory,
} from '@pos/contracts';
import { newId, type TenantScopedDb } from '@pos/db';

import {
  AuthorizationService,
  ConflictError,
  NotFoundError,
  UnitOfWork,
  VersionConflictError,
} from '../../kernel/public/index.js';
import { type CategoryRow, toCategoryDto } from '../rows.js';
import { emitCatalogChanged } from '../shared/events.js';
import { buildPatch, queryPage } from '../shared/sql.js';

const COLUMNS = {
  kind: 'kind',
  code: 'code',
  name: 'name',
  displayOrder: 'display_order',
  imageUri: 'image_uri',
  defaultTaxClassId: 'default_tax_class_id',
  kitchenTags: 'kitchen_tags',
  status: 'status',
} as const;

/** "/food/burgers": one slug per level, from the category's code or, failing that, its name. */
export function pathSlug(code: string | null | undefined, name: string): string {
  const source = (code && code.trim()) || name;
  const slug = source
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'category';
}

@Injectable()
export class CategoriesService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
  ) {}

  async list(query: CategoryListQuery): Promise<Page<CategoryDto>> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read(async (db) => {
      const where = [];
      if (query.kind) where.push({ sql: 't.kind = ?', value: query.kind });
      if (query.status) where.push({ sql: 't.status = ?', value: query.status });
      if (query.parentId) where.push({ sql: 't.parent_id = ?', value: query.parentId });
      if (query.under) {
        const root = await this.require(db, query.under);
        where.push({ sql: 't.path LIKE ?', value: `${root.path}/%` });
      }
      return queryPage<CategoryRow, CategoryDto>(
        db,
        {
          from: 'catalog.categories t',
          where,
          cursor: query.cursor,
          limit: query.limit,
        },
        toCategoryDto,
      );
    });
  }

  async get(id: string): Promise<CategoryDto> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read((db) => this.require(db, id));
  }

  async create(input: CreateCategory): Promise<CategoryDto> {
    await this.authz.assert('catalog.item.manage');
    return this.uow.run(async (uow) => {
      const parent = input.parentId ? await this.require(uow.db, input.parentId) : null;
      const path = `${parent ? parent.path : ''}/${pathSlug(input.code, input.name)}`;
      await this.assertPathFree(uow.db, path, null);
      const id = newId();
      const rows = await uow.db.query<CategoryRow>(
        `INSERT INTO catalog.categories (id, tenant_id, parent_id, kind, code, name, path, display_order, image_uri, default_tax_class_id, kitchen_tags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 0), $9, $10, COALESCE($11::text[], '{}')) RETURNING *`,
        [
          id,
          uow.tenantId,
          input.parentId ?? null,
          input.kind,
          input.code ?? null,
          input.name,
          path,
          input.displayOrder ?? null,
          input.imageUri ?? null,
          input.defaultTaxClassId ?? null,
          input.kitchenTags ?? null,
        ],
      );
      const created = toCategoryDto(rows[0]!);
      uow.audit({
        action: 'catalog.category.created',
        resourceKind: 'category',
        resourceId: id,
        after: created,
      });
      emitCatalogChanged(uow, { entity: 'category', entityId: id, change: 'created', version: 1 });
      return created;
    });
  }

  async update(id: string, patch: UpdateCategory, expectedVersion: number): Promise<CategoryDto> {
    await this.authz.assert('catalog.item.manage');
    return this.uow.run(async (uow) => {
      const before = await this.require(uow.db, id);
      if (before.version !== expectedVersion)
        throw new VersionConflictError(expectedVersion, before.version);
      const parentChanged = patch.parentId !== undefined && patch.parentId !== before.parentId;
      const slugChanged =
        (patch.code !== undefined && patch.code !== before.code) ||
        (patch.name !== undefined && patch.name !== before.name);
      let newPath = before.path;
      if (parentChanged || slugChanged) {
        const parentId = patch.parentId === undefined ? before.parentId : patch.parentId;
        let parentPath = '';
        if (parentId) {
          if (parentId === id)
            throw new ConflictError('CATEGORY_CYCLE', 'A category cannot be its own parent');
          const parent = await this.require(uow.db, parentId);
          if (parent.path.startsWith(`${before.path}/`))
            throw new ConflictError(
              'CATEGORY_CYCLE',
              'A category cannot move under its own descendant',
            );
          parentPath = parent.path;
        }
        newPath = `${parentPath}/${pathSlug(patch.code === undefined ? before.code : patch.code, patch.name ?? before.name)}`;
        if (newPath !== before.path) await this.assertPathFree(uow.db, newPath, id);
      }
      const { set, params } = buildPatch(
        { ...patch, ...(newPath !== before.path ? { path: newPath } : {}) },
        { ...COLUMNS, parentId: 'parent_id', path: 'path' },
        3,
      );
      if (!set) return before;
      const rows = await uow.db.query<CategoryRow>(
        `UPDATE catalog.categories SET ${set}, version = version + 1, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND version = ${expectedVersion} RETURNING *`,
        [uow.tenantId, id, ...params],
      );
      if (rows.length === 0) throw new VersionConflictError(expectedVersion, before.version);
      if (newPath !== before.path) {
        await uow.db.query(
          `UPDATE catalog.categories SET path = $3 || substr(path, $4), version = version + 1, updated_at = now()
           WHERE tenant_id = $1 AND path LIKE $2 || '/%'`,
          [uow.tenantId, before.path, newPath, before.path.length + 1],
        );
      }
      const after = toCategoryDto(rows[0]!);
      uow.audit({
        action: 'catalog.category.updated',
        resourceKind: 'category',
        resourceId: id,
        before,
        after,
      });
      emitCatalogChanged(uow, {
        entity: 'category',
        entityId: id,
        change: 'updated',
        version: after.version,
      });
      return after;
    });
  }

  async require(db: TenantScopedDb, id: string): Promise<CategoryDto> {
    const row = await db.maybeOne<CategoryRow>(
      'SELECT * FROM catalog.categories WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, id],
    );
    if (!row) throw new NotFoundError();
    return toCategoryDto(row);
  }

  private async assertPathFree(
    db: TenantScopedDb,
    path: string,
    exceptId: string | null,
  ): Promise<void> {
    const clash = await db.maybeOne<{ id: string }>(
      'SELECT id FROM catalog.categories WHERE tenant_id = $1 AND path = $2 AND ($3::uuid IS NULL OR id <> $3)',
      [db.tenantId, path, exceptId],
    );
    if (clash)
      throw new ConflictError('CATEGORY_PATH_TAKEN', `A category already exists at ${path}`);
  }
}
