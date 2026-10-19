import { Inject, Injectable } from '@nestjs/common';
import type { Limits } from '@pos/auth';
import type { CreateRoleAssignment, RoleAssignmentDto } from '@pos/contracts';
import { newId, type TenantScopedDb, type TenantUnitOfWork } from '@pos/db';
import type { Redis } from 'ioredis';

import {
  AuthorizationService,
  KernelPorts,
  NotFoundError,
  REDIS,
  RequestContextService,
  UnitOfWork,
  isOperator,
} from '../../kernel/public/index.js';
import { RolesService } from './roles.service.js';

export interface AssignmentRow {
  id: string;
  tenant_id: string;
  user_id: string;
  role_id: string;
  role_key: string;
  scope_kind: RoleAssignmentDto['scope']['kind'];
  scope_id: string;
  valid_from: Date;
  valid_to: Date | null;
  granted_by: string | null;
  reason: string | null;
  created_at: Date;
  limits: Record<string, unknown> | null;
}

const SELECT = `
  SELECT a.*, r.key AS role_key,
         (SELECT jsonb_object_agg(pl.key, pl.value) FROM identity.permission_limits pl WHERE pl.role_assignment_id = a.id AND pl.tenant_id = a.tenant_id) AS limits
  FROM identity.role_assignments a
  JOIN identity.roles r ON r.id = a.role_id`;

export function toAssignmentDto(r: AssignmentRow): RoleAssignmentDto {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    roleId: r.role_id,
    roleKey: r.role_key,
    scope: { kind: r.scope_kind, id: r.scope_id },
    validFrom: r.valid_from.toISOString(),
    validTo: r.valid_to ? r.valid_to.toISOString() : null,
    grantedBy: r.granted_by,
    reason: r.reason,
    limits: (r.limits ?? {}) as RoleAssignmentDto['limits'],
    createdAt: r.created_at.toISOString(),
  };
}

export function assignmentsVersionKey(tenantId: string, userId: string): string {
  return `av:${tenantId}:${userId}`;
}

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly context: RequestContextService,
    private readonly roles: RolesService,
    private readonly ports: KernelPorts,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async listForUser(userId: string): Promise<RoleAssignmentDto[]> {
    this.authz.assertAnywhere('access.assignment.view');
    return this.uow.read(async (db) => {
      const user = await db.maybeOne(
        'SELECT 1 FROM identity.users WHERE tenant_id = $1 AND id = $2',
        [db.tenantId, userId],
      );
      if (!user) throw new NotFoundError();
      return (
        await db.query<AssignmentRow>(
          `${SELECT} WHERE a.tenant_id = $1 AND a.user_id = $2 ORDER BY a.created_at`,
          [db.tenantId, userId],
        )
      ).map(toAssignmentDto);
    });
  }

  async grant(input: CreateRoleAssignment): Promise<RoleAssignmentDto> {
    await this.authz.assert('access.assignment.grant', input.scope);
    const principal = this.context.require().principal!;
    const grantedBy =
      !isOperator(principal) && principal.kind === 'user' ? principal.subjectId : null;
    return this.uow.run(async (uow) => {
      const role = await this.roles.require(uow.db, input.roleId);
      const dto = await this.grantIn(uow, { ...input, grantedBy, roleKey: role.key });
      uow.onCommitted(() => this.bumpVersion(uow.tenantId, input.userId));
      return dto;
    });
  }

  /** Grant inside an existing transaction (provisioning uses this for the first admin). */
  async grantIn(
    uow: TenantUnitOfWork,
    input: CreateRoleAssignment & { grantedBy: string | null; roleKey: string },
  ): Promise<RoleAssignmentDto> {
    const id = newId();
    await uow.db.query(
      `INSERT INTO identity.role_assignments (id, tenant_id, user_id, role_id, scope_kind, scope_id, valid_from, valid_to, granted_by, reason)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()), $8, $9, $10)`,
      [
        id,
        uow.tenantId,
        input.userId,
        input.roleId,
        input.scope.kind,
        input.scope.id,
        input.validFrom ?? null,
        input.validTo ?? null,
        input.grantedBy,
        input.reason ?? null,
      ],
    );
    for (const [key, value] of Object.entries((input.limits ?? {}) as Limits)) {
      await uow.db.query(
        'INSERT INTO identity.permission_limits (tenant_id, role_assignment_id, key, value) VALUES ($1, $2, $3, $4)',
        [uow.tenantId, id, key, JSON.stringify(value)],
      );
    }
    const dto = toAssignmentDto(
      (
        await uow.db.query<AssignmentRow>(`${SELECT} WHERE a.tenant_id = $1 AND a.id = $2`, [
          uow.tenantId,
          id,
        ])
      )[0]!,
    );
    uow.audit({
      action: 'access.assignment.granted',
      resourceKind: 'role_assignment',
      resourceId: id,
      after: {
        userId: dto.userId,
        roleKey: input.roleKey,
        scope: dto.scope,
        validTo: dto.validTo,
        limits: dto.limits,
      },
      reason: input.reason ?? null,
      locationId: input.scope.kind === 'location' ? input.scope.id : null,
    });
    uow.emit({
      type: 'role_assignment.granted',
      aggregateKind: 'user',
      aggregateId: input.userId,
      payload: { assignmentId: id, roleKey: input.roleKey, scope: dto.scope },
    });
    return dto;
  }

  async revoke(assignmentId: string, reason?: string): Promise<void> {
    await this.uow.run(async (uow) => {
      const row = await uow.db.maybeOne<AssignmentRow>(
        `${SELECT} WHERE a.tenant_id = $1 AND a.id = $2`,
        [uow.tenantId, assignmentId],
      );
      if (!row) throw new NotFoundError();
      await this.authz.assert('access.assignment.revoke', {
        kind: row.scope_kind,
        id: row.scope_id,
      });
      await uow.db.query('DELETE FROM identity.role_assignments WHERE tenant_id = $1 AND id = $2', [
        uow.tenantId,
        assignmentId,
      ]);
      const before = toAssignmentDto(row);
      uow.audit({
        action: 'access.assignment.revoked',
        resourceKind: 'role_assignment',
        resourceId: assignmentId,
        before,
        reason: reason ?? null,
      });
      uow.emit({
        type: 'role_assignment.revoked',
        aggregateKind: 'user',
        aggregateId: row.user_id,
        payload: { assignmentId, roleKey: row.role_key },
      });
      uow.onCommitted(() => this.bumpVersion(uow.tenantId, row.user_id));
    });
  }

  async bumpVersion(tenantId: string, userId: string): Promise<void> {
    await this.redis.incr(assignmentsVersionKey(tenantId, userId));
  }

  async currentVersion(tenantId: string, userId: string): Promise<number> {
    const value = await this.redis.get(assignmentsVersionKey(tenantId, userId));
    return value ? Number(value) : 0;
  }

  /** Raw rows for the effective-permissions builder. */
  async rowsForUser(db: TenantScopedDb, userId: string): Promise<AssignmentRow[]> {
    return db.query<AssignmentRow>(`${SELECT} WHERE a.tenant_id = $1 AND a.user_id = $2`, [
      db.tenantId,
      userId,
    ]);
  }

  get scopeResolver() {
    return this.ports.scopeResolver;
  }
}
