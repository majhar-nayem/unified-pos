import { Inject, Injectable } from '@nestjs/common';
import {
  type Assignment,
  type Limits,
  type PermissionKey,
  mergeLimits,
  requiresMfa,
} from '@pos/auth';
import type { TenantScopedDb } from '@pos/db';
import type { Redis } from 'ioredis';

import { REDIS, UnitOfWork } from '../../kernel/public/index.js';
import { AssignmentsService } from './assignments.service.js';
import { systemRoleLimits } from './roles.service.js';

const CACHE_TTL = 300;

export interface EffectivePermissions {
  readonly assignments: Assignment[];
  readonly version: number;
  readonly mfaRequired: boolean;
}

/**
 * Builds @pos/auth Assignment[] for a user: role permissions (system roles are readable through the
 * role_permissions policy), role-level limits (catalog for system roles, permission_limits for
 * tenant roles) merged with assignment-level limits. Cached in Redis per assignments version.
 */
@Injectable()
export class EffectivePermissionsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly assignments: AssignmentsService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async build(tenantId: string, userId: string): Promise<EffectivePermissions> {
    const version = await this.assignments.currentVersion(tenantId, userId);
    const cacheKey = `principal:${tenantId}:${userId}:${version}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as EffectivePermissions;
    const assignments = await this.uow.readAs(tenantId, (db) => this.buildIn(db, userId));
    const result: EffectivePermissions = {
      assignments,
      version,
      mfaRequired: requiresMfa(assignments.flatMap((a) => a.permissions)),
    };
    await this.redis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL);
    return result;
  }

  async buildIn(db: TenantScopedDb, userId: string): Promise<Assignment[]> {
    const rows = await this.assignments.rowsForUser(db, userId);
    if (rows.length === 0) return [];
    const roleIds = [...new Set(rows.map((r) => r.role_id))];
    const permissionRows = await db.query<{ role_id: string; permission_key: PermissionKey }>(
      'SELECT role_id, permission_key FROM identity.role_permissions WHERE role_id = ANY($1::uuid[])',
      [roleIds],
    );
    const roleRows = await db.query<{
      id: string;
      key: string;
      is_system: boolean;
      limits: Record<string, unknown> | null;
    }>(
      `SELECT r.id, r.key, r.is_system,
              (SELECT jsonb_object_agg(pl.key, pl.value) FROM identity.permission_limits pl WHERE pl.role_id = r.id AND pl.tenant_id = $1) AS limits
       FROM identity.roles r WHERE r.id = ANY($2::uuid[])`,
      [db.tenantId, roleIds],
    );
    const permissionsByRole = new Map<string, PermissionKey[]>();
    for (const p of permissionRows)
      permissionsByRole.set(p.role_id, [
        ...(permissionsByRole.get(p.role_id) ?? []),
        p.permission_key,
      ]);
    const rolesById = new Map(roleRows.map((r) => [r.id, r]));

    return rows.map((row) => {
      const role = rolesById.get(row.role_id);
      const roleLimits: Limits = role?.is_system
        ? systemRoleLimits(role.key)
        : ((role?.limits ?? {}) as Limits);
      const limits = mergeLimits(roleLimits, (row.limits ?? {}) as Limits);
      return {
        assignmentId: row.id,
        role: row.role_key,
        permissions: permissionsByRole.get(row.role_id) ?? [],
        scope: { kind: row.scope_kind, id: row.scope_id },
        coveredScopeIds: [],
        validFrom: row.valid_from.toISOString(),
        ...(row.valid_to ? { validTo: row.valid_to.toISOString() } : {}),
        ...(Object.keys(limits).length > 0 ? { limits } : {}),
      };
    });
  }
}
