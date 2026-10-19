import { Inject, Injectable } from '@nestjs/common';
import {
  type AuditActor,
  type Pool,
  type TenantScopedDb,
  type TenantUnitOfWork,
  readInTenant,
  runInTenantTransaction,
} from '@pos/db';

import { type AuthenticatedPrincipal, isOperator } from './auth/authenticator.js';
import { PG_POOL } from './database.module.js';
import { UnauthorizedError } from './errors/errors.js';
import { RequestContextService } from './request-context.js';

/** Nest wrapper around @pos/db's unit of work that takes tenant, actor and correlation from the request. */
@Injectable()
export class UnitOfWork {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly context: RequestContextService,
  ) {}

  /** Transaction for the current request's tenant. */
  run<T>(fn: (uow: TenantUnitOfWork) => Promise<T>): Promise<T> {
    const ctx = this.context.require();
    if (!ctx.tenantId || !ctx.principal) throw new UnauthorizedError();
    return runInTenantTransaction(this.pool, ctx.tenantId, fn, {
      actor: actorFrom(ctx.principal, ctx.ip),
      correlationId: ctx.correlationId,
    });
  }

  /** Transaction for an explicit tenant (operator provisioning, jobs). */
  runAs<T>(
    tenantId: string,
    actor: AuditActor,
    fn: (uow: TenantUnitOfWork) => Promise<T>,
  ): Promise<T> {
    const ctx = this.context.current();
    return runInTenantTransaction(this.pool, tenantId, fn, {
      actor,
      correlationId: ctx?.correlationId ?? null,
    });
  }

  /** Read-only transaction for the current request's tenant. */
  read<T>(fn: (db: TenantScopedDb) => Promise<T>): Promise<T> {
    const ctx = this.context.require();
    if (!ctx.tenantId) throw new UnauthorizedError();
    return readInTenant(this.pool, ctx.tenantId, fn);
  }

  readAs<T>(tenantId: string, fn: (db: TenantScopedDb) => Promise<T>): Promise<T> {
    return readInTenant(this.pool, tenantId, fn);
  }
}

export function actorFrom(principal: AuthenticatedPrincipal, ip?: string): AuditActor {
  if (isOperator(principal)) return { kind: 'operator', id: principal.operatorId, ip: ip ?? null };
  return {
    kind: principal.kind,
    id: principal.subjectId,
    deviceId: principal.deviceId ?? null,
    locationId: principal.locationId ?? null,
    ip: ip ?? null,
  };
}
