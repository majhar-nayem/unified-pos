import { Injectable } from '@nestjs/common';
import type { CreateOrgUnit, ReparentOrgUnit, UpdateOrgUnit } from '@pos/contracts';
import { newId, type TenantScopedDb, type TenantUnitOfWork } from '@pos/db';

import {
  AuthorizationService,
  NotFoundError,
  UnitOfWork,
  VersionConflictError,
} from '../kernel/public/index.js';
import { HierarchyService } from './hierarchy.service.js';
import { type OrgUnitOut, type OrgUnitRow, buildPatch, toOrgUnitDto } from './rows.js';

const COLUMNS = {
  kind: 'kind',
  code: 'code',
  name: 'name',
  legalEntityId: 'legal_entity_id',
  reportingBoundary: 'reporting_boundary',
  status: 'status',
} as const;
const SELECT = 'SELECT * FROM tenancy.org_units';

@Injectable()
export class OrgUnitsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly hierarchy: HierarchyService,
  ) {}

  async list(): Promise<OrgUnitOut[]> {
    await this.authz.assert('tenancy.org_unit.view');
    return this.uow.read(async (db) =>
      (
        await db.query<OrgUnitRow>(`${SELECT} WHERE tenant_id = $1 ORDER BY code`, [db.tenantId])
      ).map(toOrgUnitDto),
    );
  }

  async get(id: string): Promise<OrgUnitOut> {
    await this.authz.assert('tenancy.org_unit.view', { kind: 'org_unit', id });
    return this.uow.read((db) => this.require(db, id));
  }

  async create(input: CreateOrgUnit): Promise<OrgUnitOut> {
    const parentScope = input.parentId
      ? ({ kind: 'org_unit', id: input.parentId } as const)
      : undefined;
    await this.authz.assert('tenancy.org_unit.manage', parentScope);
    return this.uow.run(async (uow) => {
      if (input.parentId) await this.hierarchy.requireScope(uow.db, 'org_unit', input.parentId);
      const id = newId();
      const rows = await uow.db.query<OrgUnitRow>(
        `INSERT INTO tenancy.org_units (id, tenant_id, parent_id, kind, code, name, legal_entity_id, reporting_boundary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          id,
          uow.tenantId,
          input.parentId ?? null,
          input.kind,
          input.code,
          input.name,
          input.legalEntityId ?? null,
          input.reportingBoundary ?? false,
        ],
      );
      const created = toOrgUnitDto(rows[0]!);
      uow.audit({
        action: 'tenancy.org_unit.created',
        resourceKind: 'org_unit',
        resourceId: id,
        after: created,
      });
      return created;
    });
  }

  async update(id: string, patch: UpdateOrgUnit, expectedVersion: number): Promise<OrgUnitOut> {
    await this.authz.assert('tenancy.org_unit.manage', { kind: 'org_unit', id });
    return this.uow.run(async (uow) => {
      const before = await this.require(uow.db, id);
      const { set, params } = buildPatch(patch, COLUMNS, 3);
      if (!set) return before;
      const rows = await uow.db.query<OrgUnitRow>(
        `UPDATE tenancy.org_units SET ${set}, version = version + 1, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND version = ${expectedVersion} RETURNING *`,
        [uow.tenantId, id, ...params],
      );
      if (rows.length === 0) throw new VersionConflictError(expectedVersion, before.version);
      const after = toOrgUnitDto(rows[0]!);
      uow.audit({
        action: 'tenancy.org_unit.updated',
        resourceKind: 'org_unit',
        resourceId: id,
        before,
        after,
      });
      return after;
    });
  }

  async reparent(id: string, input: ReparentOrgUnit, expectedVersion: number): Promise<OrgUnitOut> {
    await this.authz.assert('tenancy.org_unit.manage', { kind: 'org_unit', id });
    if (input.parentId)
      await this.authz.assert('tenancy.org_unit.manage', { kind: 'org_unit', id: input.parentId });
    return this.uow.run(async (uow) => {
      await uow.db.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        'org_units',
        uow.tenantId,
      ]);
      const before = await this.require(uow.db, id);
      if (input.parentId) await this.hierarchy.requireScope(uow.db, 'org_unit', input.parentId);
      const rows = await uow.db.query<OrgUnitRow>(
        `UPDATE tenancy.org_units SET parent_id = $3, version = version + 1, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND version = $4 RETURNING *`,
        [uow.tenantId, id, input.parentId, expectedVersion],
      );
      if (rows.length === 0) throw new VersionConflictError(expectedVersion, before.version);
      const after = toOrgUnitDto(rows[0]!);
      uow.audit({
        action: 'tenancy.org_unit.reparented',
        resourceKind: 'org_unit',
        resourceId: id,
        before,
        after,
      });
      uow.emit({
        type: 'org_unit.reparented',
        aggregateKind: 'org_unit',
        aggregateId: id,
        aggregateVersion: after.version,
        payload: { parentId: after.parentId, previousParentId: before.parentId },
      });
      return after;
    });
  }

  private async require(db: TenantScopedDb, id: string): Promise<OrgUnitOut> {
    const row = await db.maybeOne<OrgUnitRow>(`${SELECT} WHERE tenant_id = $1 AND id = $2`, [
      db.tenantId,
      id,
    ]);
    if (!row) throw new NotFoundError();
    return toOrgUnitDto(row);
  }
}

export type { TenantUnitOfWork };
