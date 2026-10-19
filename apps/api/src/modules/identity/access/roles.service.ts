import { Injectable } from '@nestjs/common';
import { type Limits, PERMISSION_KEYS, type PermissionKey, SYSTEM_ROLES } from '@pos/auth';
import type { CloneRole, CreateRole, RoleDto } from '@pos/contracts';
import { newId, type TenantScopedDb } from '@pos/db';

import {
  AuthorizationService,
  ForbiddenError,
  NotFoundError,
  UnitOfWork,
  ValidationError,
} from '../../kernel/public/index.js';

interface RoleRow {
  id: string;
  tenant_id: string | null;
  key: string;
  name: string;
  description: string | null;
  is_system: boolean;
  created_at: Date;
  updated_at: Date;
  permissions: string[] | null;
  limits: Record<string, unknown> | null;
}

/** Roles with their permissions and role-level limits. System-role limits come from the catalog (no tenant rows). */
const SELECT = `
  SELECT r.*,
         (SELECT array_agg(rp.permission_key ORDER BY rp.permission_key) FROM identity.role_permissions rp WHERE rp.role_id = r.id) AS permissions,
         (SELECT jsonb_object_agg(pl.key, pl.value) FROM identity.permission_limits pl WHERE pl.role_id = r.id AND pl.tenant_id = $1) AS limits
  FROM identity.roles r`;

export function systemRoleLimits(key: string): Limits {
  return SYSTEM_ROLES.find((r) => r.key === key)?.limits ?? {};
}

export function toRoleDto(r: RoleRow): RoleDto {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    key: r.key,
    name: r.name,
    description: r.description,
    isSystem: r.is_system,
    permissions: r.permissions ?? [],
    limits: (r.is_system ? { ...systemRoleLimits(r.key) } : (r.limits ?? {})) as RoleDto['limits'],
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

@Injectable()
export class RolesService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
  ) {}

  async list(): Promise<RoleDto[]> {
    this.authz.assertAnywhere('access.role.view');
    return this.uow.read(async (db) =>
      (
        await db.query<RoleRow>(
          `${SELECT} WHERE r.tenant_id IS NULL OR r.tenant_id = $1 ORDER BY r.is_system DESC, r.key`,
          [db.tenantId],
        )
      ).map(toRoleDto),
    );
  }

  async get(roleId: string): Promise<RoleDto> {
    this.authz.assertAnywhere('access.role.view');
    return this.uow.read((db) => this.require(db, roleId));
  }

  async create(input: CreateRole): Promise<RoleDto> {
    await this.authz.assert('access.role.manage');
    assertKnownPermissions(input.permissions ?? []);
    return this.uow.run(async (uow) => {
      const id = newId();
      await uow.db.query(
        'INSERT INTO identity.roles (id, tenant_id, key, name, description, is_system) VALUES ($1, $2, $3, $4, $5, false)',
        [id, uow.tenantId, input.key, input.name, input.description ?? null],
      );
      await this.replacePermissions(uow.db, id, (input.permissions ?? []) as PermissionKey[]);
      await this.replaceLimits(uow.db, id, (input.limits ?? {}) as Limits);
      const role = await this.require(uow.db, id);
      uow.audit({
        action: 'access.role.created',
        resourceKind: 'role',
        resourceId: id,
        after: role,
      });
      return role;
    });
  }

  /** Clone a system or tenant role into a new tenant role (the way tenants customise system roles). */
  async clone(roleId: string, input: CloneRole): Promise<RoleDto> {
    await this.authz.assert('access.role.manage');
    return this.uow.run(async (uow) => {
      const source = await this.require(uow.db, roleId);
      const id = newId();
      await uow.db.query(
        'INSERT INTO identity.roles (id, tenant_id, key, name, description, is_system) VALUES ($1, $2, $3, $4, $5, false)',
        [id, uow.tenantId, input.key, input.name, `Cloned from ${source.key}`],
      );
      await this.replacePermissions(uow.db, id, source.permissions as PermissionKey[]);
      await this.replaceLimits(uow.db, id, source.limits as Limits);
      const role = await this.require(uow.db, id);
      uow.audit({
        action: 'access.role.cloned',
        resourceKind: 'role',
        resourceId: id,
        before: { sourceRoleId: source.id, sourceKey: source.key },
        after: role,
      });
      return role;
    });
  }

  async updatePermissions(roleId: string, permissions: string[]): Promise<RoleDto> {
    await this.authz.assert('access.role.manage');
    assertKnownPermissions(permissions);
    return this.uow.run(async (uow) => {
      const before = await this.require(uow.db, roleId);
      if (before.isSystem)
        throw new ForbiddenError(
          'SYSTEM_ROLE_IMMUTABLE',
          'System roles cannot be edited; clone the role instead',
        );
      await this.replacePermissions(uow.db, roleId, permissions as PermissionKey[]);
      const after = await this.require(uow.db, roleId);
      uow.audit({
        action: 'access.role.updated',
        resourceKind: 'role',
        resourceId: roleId,
        before: { permissions: before.permissions },
        after: { permissions: after.permissions },
      });
      return after;
    });
  }

  async setLimits(roleId: string, limits: Limits): Promise<RoleDto> {
    await this.authz.assert('access.limit.manage');
    return this.uow.run(async (uow) => {
      const before = await this.require(uow.db, roleId);
      if (before.isSystem)
        throw new ForbiddenError(
          'SYSTEM_ROLE_IMMUTABLE',
          'System roles cannot be edited; clone the role instead',
        );
      await this.replaceLimits(uow.db, roleId, limits);
      const after = await this.require(uow.db, roleId);
      uow.audit({
        action: 'access.role.limits_updated',
        resourceKind: 'role',
        resourceId: roleId,
        before: { limits: before.limits },
        after: { limits: after.limits },
      });
      return after;
    });
  }

  async require(db: TenantScopedDb, roleId: string): Promise<RoleDto> {
    const row = await db.maybeOne<RoleRow>(
      `${SELECT} WHERE r.id = $2 AND (r.tenant_id IS NULL OR r.tenant_id = $1)`,
      [db.tenantId, roleId],
    );
    if (!row) throw new NotFoundError();
    return toRoleDto(row);
  }

  private async replacePermissions(
    db: TenantScopedDb,
    roleId: string,
    permissions: readonly PermissionKey[],
  ): Promise<void> {
    await db.query('DELETE FROM identity.role_permissions WHERE role_id = $1', [roleId]);
    for (const key of new Set(permissions)) {
      await db.query(
        'INSERT INTO identity.role_permissions (role_id, permission_key) VALUES ($1, $2)',
        [roleId, key],
      );
    }
  }

  private async replaceLimits(db: TenantScopedDb, roleId: string, limits: Limits): Promise<void> {
    await db.query('DELETE FROM identity.permission_limits WHERE tenant_id = $1 AND role_id = $2', [
      db.tenantId,
      roleId,
    ]);
    for (const [key, value] of Object.entries(limits)) {
      await db.query(
        'INSERT INTO identity.permission_limits (tenant_id, role_id, key, value) VALUES ($1, $2, $3, $4)',
        [db.tenantId, roleId, key, JSON.stringify(value)],
      );
    }
  }
}

function assertKnownPermissions(permissions: readonly string[]): void {
  const unknown = permissions.filter((p) => !(PERMISSION_KEYS as readonly string[]).includes(p));
  if (unknown.length > 0)
    throw new ValidationError({ permissions: `unknown permission keys: ${unknown.join(', ')}` });
}
