import { Injectable } from '@nestjs/common';
import type { CreateRegister, RegisterDto, UpdateRegister } from '@pos/contracts';
import { newId, type TenantScopedDb } from '@pos/db';

import {
  AuthorizationService,
  NotFoundError,
  RequestContextService,
  UnitOfWork,
  VersionConflictError,
  isOperator,
  principalReaches,
} from '../kernel/public/index.js';
import { type RegisterRow, buildPatch, toRegisterDto } from './rows.js';

const COLUMNS = {
  departmentId: 'department_id',
  code: 'code',
  name: 'name',
  kind: 'kind',
  status: 'status',
} as const;

const LIST_SQL = `
  SELECT r.*, l.id AS location_id, COALESCE(array_agg(p.ancestor_id ORDER BY p.depth) FILTER (WHERE p.ancestor_id IS NOT NULL), '{}') AS ancestor_ids
  FROM tenancy.registers r
  JOIN tenancy.locations l ON l.tenant_id = r.tenant_id AND l.id = r.location_id
  LEFT JOIN tenancy.org_unit_paths p ON p.tenant_id = l.tenant_id AND p.descendant_id = l.org_unit_id
  WHERE r.tenant_id = $1 AND ($2::uuid IS NULL OR r.location_id = $2)
  GROUP BY r.id, l.id
  ORDER BY l.code, r.code`;

@Injectable()
export class RegistersService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly context: RequestContextService,
  ) {}

  async list(locationId?: string): Promise<RegisterDto[]> {
    if (locationId)
      await this.authz.assert('tenancy.register.view', { kind: 'location', id: locationId });
    const principal = this.context.require().principal;
    const rows = await this.uow.read((db) =>
      db.query<RegisterRow & { ancestor_ids: string[] }>(LIST_SQL, [
        db.tenantId,
        locationId ?? null,
      ]),
    );
    const out: RegisterDto[] = [];
    for (const row of rows) {
      const path = [
        { kind: 'register' as const, id: row.id },
        { kind: 'location' as const, id: row.location_id },
        ...row.ancestor_ids.map((id) => ({ kind: 'org_unit' as const, id })),
      ];
      if (
        principal &&
        !isOperator(principal) &&
        !principalReaches(principal, { kind: 'register', id: row.id, path })
      )
        continue;
      const decision = await this.authz.can('tenancy.register.view', {
        kind: 'register',
        id: row.id,
      });
      if (decision.allowed) out.push(toRegisterDto(row));
    }
    return out;
  }

  async get(id: string): Promise<RegisterDto> {
    await this.authz.assert('tenancy.register.view', { kind: 'register', id });
    return this.uow.read((db) => this.require(db, id));
  }

  async create(locationId: string, input: CreateRegister): Promise<RegisterDto> {
    await this.authz.assert('tenancy.register.manage', { kind: 'location', id: locationId });
    return this.uow.run(async (uow) => {
      const id = newId();
      const rows = await uow.db.query<RegisterRow>(
        `INSERT INTO tenancy.registers (id, tenant_id, location_id, department_id, code, name, kind)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'pos')) RETURNING *`,
        [
          id,
          uow.tenantId,
          locationId,
          input.departmentId ?? null,
          input.code,
          input.name,
          input.kind ?? null,
        ],
      );
      const created = toRegisterDto(rows[0]!);
      uow.audit({
        action: 'tenancy.register.created',
        resourceKind: 'register',
        resourceId: id,
        after: created,
        locationId,
      });
      uow.emit({
        type: 'register.created',
        aggregateKind: 'register',
        aggregateId: id,
        aggregateVersion: 1,
        locationId,
        payload: { code: created.code, name: created.name },
      });
      return created;
    });
  }

  async update(id: string, patch: UpdateRegister, expectedVersion: number): Promise<RegisterDto> {
    await this.authz.assert('tenancy.register.manage', { kind: 'register', id });
    return this.uow.run(async (uow) => {
      const before = await this.require(uow.db, id);
      const { set, params } = buildPatch(patch, COLUMNS, 3);
      if (!set) return before;
      const rows = await uow.db.query<RegisterRow>(
        `UPDATE tenancy.registers SET ${set}, version = version + 1, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND version = ${expectedVersion} RETURNING *`,
        [uow.tenantId, id, ...params],
      );
      if (rows.length === 0) throw new VersionConflictError(expectedVersion, before.version);
      const after = toRegisterDto(rows[0]!);
      uow.audit({
        action: 'tenancy.register.updated',
        resourceKind: 'register',
        resourceId: id,
        before,
        after,
        locationId: after.locationId,
      });
      return after;
    });
  }

  private async require(db: TenantScopedDb, id: string): Promise<RegisterDto> {
    const row = await db.maybeOne<RegisterRow>(
      'SELECT * FROM tenancy.registers WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, id],
    );
    if (!row) throw new NotFoundError();
    return toRegisterDto(row);
  }
}
