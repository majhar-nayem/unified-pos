import { Injectable } from '@nestjs/common';
import type { CreateDepartment, CreateLocation, LocationDto, UpdateLocation } from '@pos/contracts';
import { newId, type TenantScopedDb } from '@pos/db';

import {
  AuthorizationService,
  NotFoundError,
  RequestContextService,
  UnitOfWork,
  VersionConflictError,
  isOperator,
} from '../kernel/public/index.js';
import { HierarchyService, reachable } from './hierarchy.service.js';
import {
  type DepartmentOut,
  type DepartmentRow,
  type LocationRow,
  buildPatch,
  toDepartmentDto,
  toLocationDto,
} from './rows.js';

const COLUMNS = {
  orgUnitId: 'org_unit_id',
  legalEntityId: 'legal_entity_id',
  code: 'code',
  name: 'name',
  kind: 'kind',
  deploymentProfile: 'deployment_profile',
  timezone: 'timezone',
  currency: 'currency',
  locale: 'locale',
  businessDayBoundary: 'business_day_boundary',
  address: 'address',
  status: 'status',
} as const;

/** Locations with the org-unit ancestor chain, so list endpoints can filter by reach in one query. */
const LIST_SQL = `
  SELECT l.*, COALESCE(array_agg(p.ancestor_id ORDER BY p.depth) FILTER (WHERE p.ancestor_id IS NOT NULL), '{}') AS ancestor_ids
  FROM tenancy.locations l
  LEFT JOIN tenancy.org_unit_paths p ON p.tenant_id = l.tenant_id AND p.descendant_id = l.org_unit_id
  WHERE l.tenant_id = $1
  GROUP BY l.id
  ORDER BY l.code`;

@Injectable()
export class LocationsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly hierarchy: HierarchyService,
    private readonly context: RequestContextService,
  ) {}

  /** Every location the caller can reach (no scope guard on the list route). */
  async list(): Promise<LocationDto[]> {
    const principal = this.context.require().principal;
    const rows = await this.uow.read((db) =>
      db.query<LocationRow & { ancestor_ids: string[] }>(LIST_SQL, [db.tenantId]),
    );
    const visible =
      !principal || isOperator(principal)
        ? rows
        : reachable(
            principal,
            'location',
            rows.map((r) => ({ ...r, ancestorIds: r.ancestor_ids })),
          );
    const allowed: LocationDto[] = [];
    for (const row of visible) {
      const decision = await this.authz.can('tenancy.location.view', {
        kind: 'location',
        id: row.id,
      });
      if (decision.allowed) allowed.push(toLocationDto(row));
    }
    return allowed;
  }

  async get(id: string): Promise<LocationDto> {
    await this.authz.assert('tenancy.location.view', { kind: 'location', id });
    return this.uow.read((db) => this.require(db, id));
  }

  async create(input: CreateLocation): Promise<LocationDto> {
    await this.authz.assert('tenancy.location.manage', { kind: 'org_unit', id: input.orgUnitId });
    return this.uow.run(async (uow) => {
      await this.hierarchy.requireScope(uow.db, 'org_unit', input.orgUnitId);
      const id = newId();
      const rows = await uow.db.query<LocationRow>(
        `INSERT INTO tenancy.locations (id, tenant_id, org_unit_id, legal_entity_id, code, name, kind, deployment_profile, timezone, currency, locale, business_day_boundary, address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'device_autonomous'), $9, $10, COALESCE($11, 'en-AU'), COALESCE($12::time, '04:00'), $13) RETURNING *`,
        [
          id,
          uow.tenantId,
          input.orgUnitId,
          input.legalEntityId ?? null,
          input.code,
          input.name,
          input.kind,
          input.deploymentProfile ?? null,
          input.timezone,
          input.currency,
          input.locale ?? null,
          input.businessDayBoundary ?? null,
          JSON.stringify(input.address ?? {}),
        ],
      );
      const created = toLocationDto(rows[0]!);
      uow.audit({
        action: 'tenancy.location.created',
        resourceKind: 'location',
        resourceId: id,
        after: created,
        locationId: id,
      });
      uow.emit({
        type: 'location.created',
        aggregateKind: 'location',
        aggregateId: id,
        aggregateVersion: 1,
        locationId: id,
        payload: { code: created.code, name: created.name, kind: created.kind },
      });
      return created;
    });
  }

  async update(id: string, patch: UpdateLocation, expectedVersion: number): Promise<LocationDto> {
    await this.authz.assert('tenancy.location.manage', { kind: 'location', id });
    if (patch.orgUnitId)
      await this.authz.assert('tenancy.location.manage', { kind: 'org_unit', id: patch.orgUnitId });
    return this.uow.run(async (uow) => {
      const before = await this.require(uow.db, id);
      const { set, params } = buildPatch(patch, COLUMNS, 3);
      if (!set) return before;
      const rows = await uow.db.query<LocationRow>(
        `UPDATE tenancy.locations SET ${set}, version = version + 1, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND version = ${expectedVersion} RETURNING *`,
        [uow.tenantId, id, ...params],
      );
      if (rows.length === 0) throw new VersionConflictError(expectedVersion, before.version);
      const after = toLocationDto(rows[0]!);
      uow.audit({
        action: 'tenancy.location.updated',
        resourceKind: 'location',
        resourceId: id,
        before,
        after,
        locationId: id,
      });
      return after;
    });
  }

  async listDepartments(locationId: string): Promise<DepartmentOut[]> {
    await this.authz.assert('tenancy.location.view', { kind: 'location', id: locationId });
    return this.uow.read(async (db) =>
      (
        await db.query<DepartmentRow>(
          'SELECT * FROM tenancy.departments WHERE tenant_id = $1 AND location_id = $2 ORDER BY code',
          [db.tenantId, locationId],
        )
      ).map(toDepartmentDto),
    );
  }

  async createDepartment(locationId: string, input: CreateDepartment): Promise<DepartmentOut> {
    await this.authz.assert('tenancy.department.manage', { kind: 'location', id: locationId });
    return this.uow.run(async (uow) => {
      await this.require(uow.db, locationId);
      const id = newId();
      const rows = await uow.db.query<DepartmentRow>(
        `INSERT INTO tenancy.departments (id, tenant_id, location_id, code, name, kind) VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'general')) RETURNING *`,
        [id, uow.tenantId, locationId, input.code, input.name, input.kind ?? null],
      );
      const created = toDepartmentDto(rows[0]!);
      uow.audit({
        action: 'tenancy.department.created',
        resourceKind: 'department',
        resourceId: id,
        after: created,
        locationId,
      });
      return created;
    });
  }

  private async require(db: TenantScopedDb, id: string): Promise<LocationDto> {
    const row = await db.maybeOne<LocationRow>(
      'SELECT * FROM tenancy.locations WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, id],
    );
    if (!row) throw new NotFoundError();
    return toLocationDto(row);
  }
}
