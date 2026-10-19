import { Injectable } from '@nestjs/common';
import type {
  BulkPriceListEntries,
  CreatePriceList,
  CreatePriceListAssignment,
  CreatePriceListEntry,
  Page,
  PriceListAssignmentDto,
  PriceListDto,
  PriceListEntryDto,
  PriceListListQuery,
  UpdatePriceList,
  UpdatePriceListAssignment,
  UpdatePriceListEntry,
  CursorQuery,
  PriceListEntryListQuery,
} from '@pos/contracts';
import { newId, type TenantScopedDb, type TenantUnitOfWork } from '@pos/db';

import {
  AuthorizationService,
  ConflictError,
  NotFoundError,
  UnitOfWork,
  ValidationError,
  VersionConflictError,
} from '../kernel/public/index.js';
import { emitPricingChanged } from './events.js';
import { PRICING_PERMISSIONS } from './permissions.js';
import {
  type PriceListAssignmentRow,
  type PriceListEntryRow,
  type PriceListRow,
  toAssignmentDto,
  toEntryDto,
  toPriceListDto,
} from './rows.js';
import { ScopeAccessService } from './scope-access.service.js';
import { buildPatch, queryPage } from './shared/sql.js';

const LIST_COLUMNS = {
  name: 'name',
  kind: 'kind',
  taxInclusive: 'tax_inclusive',
  priority: 'priority',
  status: 'status',
} as const;

const ENTRY_SELECT = `t.*, l.version AS price_list_version`;
const ENTRY_FROM = `pricing.price_list_entries t JOIN pricing.price_lists l ON l.tenant_id = t.tenant_id AND l.id = t.price_list_id`;
const ASSIGNMENT_FROM = `pricing.price_list_assignments t JOIN pricing.price_lists l ON l.tenant_id = t.tenant_id AND l.id = t.price_list_id`;

/**
 * Price lists, their entries and their assignments. The three tables form one aggregate with the
 * version on `price_lists`: entry and assignment writes are conditioned on the list's `If-Match`
 * version and bump it, so two admins editing the same list never silently overwrite each other.
 */
@Injectable()
export class PriceListsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly scopes: ScopeAccessService,
  ) {}

  // -------------------------------------------------------------------- lists

  async list(query: PriceListListQuery): Promise<Page<PriceListDto>> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.view);
    return this.uow.read((db) =>
      queryPage<PriceListRow, PriceListDto>(
        db,
        {
          from: 'pricing.price_lists t',
          where: [
            ...(query.status ? [{ sql: 't.status = ?', value: query.status }] : []),
            ...(query.kind ? [{ sql: 't.kind = ?', value: query.kind }] : []),
          ],
          cursor: query.cursor,
          limit: query.limit,
        },
        toPriceListDto,
      ),
    );
  }

  async get(id: string): Promise<PriceListDto> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.view);
    return this.uow.read(async (db) => toPriceListDto(await this.requireRow(db, id)));
  }

  async create(input: CreatePriceList): Promise<PriceListDto> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.manage);
    return this.uow.run(async (uow) => {
      const rows = await uow.db.query<PriceListRow>(
        `INSERT INTO pricing.price_lists (id, tenant_id, name, currency, kind, tax_inclusive, priority, status)
         VALUES ($1, $2, $3, $4, COALESCE($5, 'retail'), COALESCE($6, true), COALESCE($7, 100), COALESCE($8, 'active'))
         RETURNING *`,
        [
          newId(),
          uow.tenantId,
          input.name,
          input.currency,
          input.kind ?? null,
          input.taxInclusive ?? null,
          input.priority ?? null,
          input.status ?? null,
        ],
      );
      const created = toPriceListDto(rows[0]!);
      uow.audit({
        action: 'pricing.price_list.created',
        resourceKind: 'price_list',
        resourceId: created.id,
        after: created,
      });
      this.emit(uow, created, 'created', 'price_list');
      return created;
    });
  }

  async update(id: string, patch: UpdatePriceList, expectedVersion: number): Promise<PriceListDto> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.manage);
    return this.uow.run(async (uow) => {
      const before = toPriceListDto(await this.requireRow(uow.db, id));
      await this.assertCanEdit(uow.db, id);
      const { set, params } = buildPatch(patch, LIST_COLUMNS, 3);
      if (!set) return before;
      const rows = await uow.db.query<PriceListRow>(
        `UPDATE pricing.price_lists SET ${set}, version = version + 1, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND version = ${expectedVersion} RETURNING *`,
        [uow.tenantId, id, ...params],
      );
      if (rows.length === 0) throw new VersionConflictError(expectedVersion, before.version);
      const after = toPriceListDto(rows[0]!);
      uow.audit({
        action: 'pricing.price_list.updated',
        resourceKind: 'price_list',
        resourceId: id,
        before,
        after,
      });
      this.emit(uow, after, 'updated', 'price_list');
      return after;
    });
  }

  /** Only drafts can be deleted; anything that has been live is archived instead. */
  async remove(id: string, expectedVersion: number): Promise<PriceListDto> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.manage);
    return this.uow.run(async (uow) => {
      const before = toPriceListDto(await this.requireRow(uow.db, id));
      await this.assertCanEdit(uow.db, id);
      if (before.version !== expectedVersion)
        throw new VersionConflictError(expectedVersion, before.version);
      if (before.status !== 'draft') {
        throw new ConflictError(
          'PRICE_LIST_NOT_DRAFT',
          'Only draft price lists can be deleted; archive it instead',
        );
      }
      const deleted = await uow.db.query(
        'DELETE FROM pricing.price_lists WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status = $4 RETURNING id',
        [uow.tenantId, id, expectedVersion, 'draft'],
      );
      if (deleted.length === 0) throw new VersionConflictError(expectedVersion);
      uow.audit({
        action: 'pricing.price_list.deleted',
        resourceKind: 'price_list',
        resourceId: id,
        before,
      });
      this.emit(uow, before, 'deleted', 'price_list');
      return before;
    });
  }

  // ------------------------------------------------------------------ entries

  async listEntries(
    listId: string,
    query: PriceListEntryListQuery,
  ): Promise<Page<PriceListEntryDto>> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.view);
    return this.uow.read(async (db) => {
      await this.requireRow(db, listId);
      return queryPage<PriceListEntryRow, PriceListEntryDto>(
        db,
        {
          from: ENTRY_FROM,
          select: ENTRY_SELECT,
          where: [
            { sql: 't.price_list_id = ?', value: listId },
            ...(query.variantId ? [{ sql: 't.variant_id = ?', value: query.variantId }] : []),
          ],
          cursor: query.cursor,
          limit: query.limit,
        },
        toEntryDto,
      );
    });
  }

  async createEntry(
    listId: string,
    input: CreatePriceListEntry,
    expectedVersion: number,
  ): Promise<PriceListEntryDto> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.manage);
    return this.uow.run(async (uow) => {
      await this.assertCanEdit(uow.db, listId);
      const list = await this.bump(uow, listId, expectedVersion);
      const rows = await uow.db.query<PriceListEntryRow>(
        `INSERT INTO pricing.price_list_entries (id, tenant_id, price_list_id, variant_id, price_minor, min_quantity, valid_from, valid_to)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, 1), $7, $8) RETURNING *, $9::int AS price_list_version`,
        [
          newId(),
          uow.tenantId,
          listId,
          input.variantId,
          input.priceMinor,
          input.minQuantity ?? null,
          input.validFrom ?? null,
          input.validTo ?? null,
          list.version,
        ],
      );
      const created = toEntryDto(rows[0]!);
      uow.audit({
        action: 'pricing.price_list.entry_created',
        resourceKind: 'price_list',
        resourceId: listId,
        after: created,
      });
      this.emit(uow, toPriceListDto(list), 'updated', 'entry', created.id);
      return created;
    });
  }

  /** Upsert up to 1000 entries keyed by (variant, min quantity, validFrom); one version bump for the batch. */
  async upsertEntries(
    listId: string,
    input: BulkPriceListEntries,
    expectedVersion: number,
  ): Promise<{ priceListVersion: number; entries: PriceListEntryDto[] }> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.manage);
    // The last occurrence of a key wins; a batch cannot hit the same unique key twice.
    const byKey = new Map<string, BulkPriceListEntries['entries'][number]>();
    for (const e of input.entries) {
      byKey.set(`${e.variantId}|${Number(e.minQuantity ?? '1')}|${e.validFrom ?? ''}`, e);
    }
    const entries = [...byKey.values()];
    return this.uow.run(async (uow) => {
      await this.assertCanEdit(uow.db, listId);
      const list = await this.bump(uow, listId, expectedVersion);
      const rows = await uow.db.query<PriceListEntryRow>(
        `INSERT INTO pricing.price_list_entries (id, tenant_id, price_list_id, variant_id, price_minor, min_quantity, valid_from, valid_to)
         SELECT u.id, $1, $2, u.variant_id, u.price_minor, COALESCE(u.min_quantity, 1), u.valid_from, u.valid_to
         FROM unnest($3::uuid[], $4::uuid[], $5::bigint[], $6::numeric[], $7::timestamptz[], $8::timestamptz[])
           AS u(id, variant_id, price_minor, min_quantity, valid_from, valid_to)
         ON CONFLICT (price_list_id, variant_id, min_quantity, (COALESCE(valid_from, '-infinity'::timestamptz)))
         DO UPDATE SET price_minor = EXCLUDED.price_minor, valid_to = EXCLUDED.valid_to
         RETURNING *, $9::int AS price_list_version`,
        [
          uow.tenantId,
          listId,
          entries.map(() => newId()),
          entries.map((e) => e.variantId),
          entries.map((e) => e.priceMinor),
          entries.map((e) => e.minQuantity ?? null),
          entries.map((e) => e.validFrom ?? null),
          entries.map((e) => e.validTo ?? null),
          list.version,
        ],
      );
      uow.audit({
        action: 'pricing.price_list.entries_upserted',
        resourceKind: 'price_list',
        resourceId: listId,
        after: {
          count: rows.length,
          variantIds: [...new Set(rows.map((r) => r.variant_id))].slice(0, 50),
        },
      });
      this.emit(uow, toPriceListDto(list), 'updated', 'entries', undefined, { count: rows.length });
      return { priceListVersion: list.version, entries: rows.map(toEntryDto) };
    });
  }

  async updateEntry(
    listId: string,
    entryId: string,
    patch: UpdatePriceListEntry,
    expectedVersion: number,
  ): Promise<PriceListEntryDto> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.manage);
    return this.uow.run(async (uow) => {
      await this.assertCanEdit(uow.db, listId);
      const beforeRow = await uow.db.maybeOne<PriceListEntryRow>(
        `SELECT t.*, 0 AS price_list_version FROM pricing.price_list_entries t WHERE t.tenant_id = $1 AND t.price_list_id = $2 AND t.id = $3`,
        [uow.tenantId, listId, entryId],
      );
      if (!beforeRow) throw new NotFoundError();
      const from =
        patch.validFrom !== undefined
          ? patch.validFrom
          : (beforeRow.valid_from?.toISOString() ?? null);
      const to =
        patch.validTo !== undefined ? patch.validTo : (beforeRow.valid_to?.toISOString() ?? null);
      if (from && to && Date.parse(from) >= Date.parse(to)) {
        throw new ValidationError({ body: { validTo: 'validFrom must be before validTo' } });
      }
      const list = await this.bump(uow, listId, expectedVersion);
      const { set, params } = buildPatch(
        patch,
        { priceMinor: 'price_minor', validFrom: 'valid_from', validTo: 'valid_to' },
        4,
      );
      const rows = await uow.db.query<PriceListEntryRow>(
        `UPDATE pricing.price_list_entries SET ${set || 'price_minor = price_minor'}
         WHERE tenant_id = $1 AND price_list_id = $2 AND id = $3 RETURNING *, $${params.length + 4}::int AS price_list_version`,
        [uow.tenantId, listId, entryId, ...params, list.version],
      );
      const after = toEntryDto(rows[0]!);
      uow.audit({
        action: 'pricing.price_list.entry_updated',
        resourceKind: 'price_list',
        resourceId: listId,
        before: toEntryDto({ ...beforeRow, price_list_version: expectedVersion }),
        after,
      });
      this.emit(uow, toPriceListDto(list), 'updated', 'entry', entryId);
      return after;
    });
  }

  async deleteEntry(
    listId: string,
    entryId: string,
    expectedVersion: number,
  ): Promise<PriceListEntryDto> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.manage);
    return this.uow.run(async (uow) => {
      await this.assertCanEdit(uow.db, listId);
      const list = await this.bump(uow, listId, expectedVersion);
      const rows = await uow.db.query<PriceListEntryRow>(
        `DELETE FROM pricing.price_list_entries WHERE tenant_id = $1 AND price_list_id = $2 AND id = $3
         RETURNING *, $4::int AS price_list_version`,
        [uow.tenantId, listId, entryId, list.version],
      );
      if (rows.length === 0) throw new NotFoundError();
      const removed = toEntryDto(rows[0]!);
      uow.audit({
        action: 'pricing.price_list.entry_deleted',
        resourceKind: 'price_list',
        resourceId: listId,
        before: removed,
      });
      this.emit(uow, toPriceListDto(list), 'updated', 'entry', entryId);
      return removed;
    });
  }

  // -------------------------------------------------------------- assignments

  async listAssignments(listId: string, query: CursorQuery): Promise<Page<PriceListAssignmentDto>> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.view);
    return this.uow.read(async (db) => {
      await this.requireRow(db, listId);
      return queryPage<PriceListAssignmentRow, PriceListAssignmentDto>(
        db,
        {
          from: ASSIGNMENT_FROM,
          select: ENTRY_SELECT,
          where: [{ sql: 't.price_list_id = ?', value: listId }],
          cursor: query.cursor,
          limit: query.limit,
        },
        toAssignmentDto,
      );
    });
  }

  async createAssignment(
    listId: string,
    input: CreatePriceListAssignment,
    expectedVersion: number,
  ): Promise<PriceListAssignmentDto> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.manage);
    return this.uow.run(async (uow) => {
      await this.requireRow(uow.db, listId);
      await this.scopes.assertManage(uow.db, [input]);
      const list = await this.bump(uow, listId, expectedVersion);
      const rows = await uow.db.query<PriceListAssignmentRow>(
        `INSERT INTO pricing.price_list_assignments (id, tenant_id, price_list_id, scope_kind, scope_id, scope_value, priority)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 100)) RETURNING *, $8::int AS price_list_version`,
        [
          newId(),
          uow.tenantId,
          listId,
          input.scopeKind,
          input.scopeId ?? null,
          input.scopeValue ?? null,
          input.priority ?? null,
          list.version,
        ],
      );
      const created = toAssignmentDto(rows[0]!);
      uow.audit({
        action: 'pricing.price_list.assignment_created',
        resourceKind: 'price_list',
        resourceId: listId,
        after: created,
      });
      this.emit(uow, toPriceListDto(list), 'updated', 'assignment', created.id);
      return created;
    });
  }

  async updateAssignment(
    listId: string,
    assignmentId: string,
    patch: UpdatePriceListAssignment,
    expectedVersion: number,
  ): Promise<PriceListAssignmentDto> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.manage);
    return this.uow.run(async (uow) => {
      const existing = await this.requireAssignment(uow.db, listId, assignmentId);
      await this.scopes.assertManage(uow.db, [
        { scopeKind: existing.scope_kind, scopeId: existing.scope_id },
      ]);
      const list = await this.bump(uow, listId, expectedVersion);
      const rows = await uow.db.query<PriceListAssignmentRow>(
        `UPDATE pricing.price_list_assignments SET priority = $4
         WHERE tenant_id = $1 AND price_list_id = $2 AND id = $3 RETURNING *, $5::int AS price_list_version`,
        [uow.tenantId, listId, assignmentId, patch.priority, list.version],
      );
      const after = toAssignmentDto(rows[0]!);
      uow.audit({
        action: 'pricing.price_list.assignment_updated',
        resourceKind: 'price_list',
        resourceId: listId,
        before: toAssignmentDto({ ...existing, price_list_version: expectedVersion }),
        after,
      });
      this.emit(uow, toPriceListDto(list), 'updated', 'assignment', assignmentId);
      return after;
    });
  }

  async deleteAssignment(
    listId: string,
    assignmentId: string,
    expectedVersion: number,
  ): Promise<PriceListAssignmentDto> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.manage);
    return this.uow.run(async (uow) => {
      const existing = await this.requireAssignment(uow.db, listId, assignmentId);
      await this.scopes.assertManage(uow.db, [
        { scopeKind: existing.scope_kind, scopeId: existing.scope_id },
      ]);
      const list = await this.bump(uow, listId, expectedVersion);
      await uow.db.query(
        'DELETE FROM pricing.price_list_assignments WHERE tenant_id = $1 AND price_list_id = $2 AND id = $3',
        [uow.tenantId, listId, assignmentId],
      );
      const removed = toAssignmentDto({ ...existing, price_list_version: list.version });
      uow.audit({
        action: 'pricing.price_list.assignment_deleted',
        resourceKind: 'price_list',
        resourceId: listId,
        before: removed,
      });
      this.emit(uow, toPriceListDto(list), 'updated', 'assignment', assignmentId);
      return removed;
    });
  }

  // ----------------------------------------------------------------- internals

  /** The caller must manage every place this list is assigned (tenant level when it has no assignments yet). */
  private async assertCanEdit(db: TenantScopedDb, listId: string): Promise<void> {
    await this.requireRow(db, listId);
    const targets = await db.query<{ scope_kind: string; scope_id: string | null }>(
      'SELECT scope_kind, scope_id FROM pricing.price_list_assignments WHERE tenant_id = $1 AND price_list_id = $2',
      [db.tenantId, listId],
    );
    await this.scopes.assertManage(
      db,
      targets.map((t) => ({ scopeKind: t.scope_kind, scopeId: t.scope_id })),
    );
  }

  /** Condition a child write on the list's version and bump it; the UPDATE also locks the list row. */
  private async bump(
    uow: TenantUnitOfWork,
    listId: string,
    expectedVersion: number,
  ): Promise<PriceListRow> {
    const rows = await uow.db.query<PriceListRow>(
      `UPDATE pricing.price_lists SET version = version + 1, updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
      [uow.tenantId, listId, expectedVersion],
    );
    if (rows[0]) return rows[0];
    const current = await this.requireRow(uow.db, listId);
    throw new VersionConflictError(expectedVersion, current.version);
  }

  private async requireRow(db: TenantScopedDb, id: string): Promise<PriceListRow> {
    const row = await db.maybeOne<PriceListRow>(
      'SELECT * FROM pricing.price_lists WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, id],
    );
    if (!row) throw new NotFoundError();
    return row;
  }

  private async requireAssignment(
    db: TenantScopedDb,
    listId: string,
    id: string,
  ): Promise<PriceListAssignmentRow> {
    const row = await db.maybeOne<PriceListAssignmentRow>(
      `SELECT t.*, l.version AS price_list_version FROM ${ASSIGNMENT_FROM}
       WHERE t.tenant_id = $1 AND t.price_list_id = $2 AND t.id = $3`,
      [db.tenantId, listId, id],
    );
    if (!row) throw new NotFoundError();
    return row;
  }

  private emit(
    uow: TenantUnitOfWork,
    list: PriceListDto,
    change: 'created' | 'updated' | 'deleted',
    entity: string,
    entityId?: string,
    detail?: Record<string, unknown>,
  ): void {
    emitPricingChanged(uow, 'pricing.price_list.changed', {
      aggregateKind: 'price_list',
      aggregateId: list.id,
      version: list.version,
      entity,
      ...(entityId ? { entityId } : {}),
      change,
      ...(detail ? { detail } : {}),
    });
  }
}
