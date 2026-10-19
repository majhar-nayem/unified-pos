import { Injectable } from '@nestjs/common';
import type { AuditActor, TenantUnitOfWork } from '@pos/db';

import {
  RequestContextService,
  UnauthorizedError,
  UnitOfWork,
  actorFrom,
  isOperator,
} from '../kernel/public/index.js';
import type { Caller } from './ledger.service.js';

export const SYSTEM_CALLER: Caller = { source: 'system' };
export const SYSTEM_ACTOR: AuditActor = { kind: 'system' };

export interface CallerContext {
  readonly tenantId: string;
  readonly actor: AuditActor;
  readonly caller: Caller;
}

/**
 * Runs payment work in a tenant transaction as the request's caller (HTTP) or as the system
 * (sweepers, webhooks). Provider calls never happen inside these transactions: services prepare in
 * one, call the provider, then settle in another so a crash leaves a recoverable `processing` row.
 */
@Injectable()
export class PaymentsRunner {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly context: RequestContextService,
  ) {}

  /** The authenticated caller of the current request. */
  request(): CallerContext {
    const ctx = this.context.require();
    const principal = ctx.principal;
    if (!principal || !ctx.tenantId) throw new UnauthorizedError();
    const actor = actorFrom(principal, ctx.ip);
    if (isOperator(principal))
      return { tenantId: ctx.tenantId, actor, caller: { source: 'admin' } };
    return {
      tenantId: ctx.tenantId,
      actor,
      caller: {
        source:
          principal.tokenKind === 'pos' || principal.tokenKind === 'device'
            ? 'pos'
            : principal.tokenKind === 'api'
              ? 'api'
              : 'admin',
        actorUserId: principal.kind === 'user' ? principal.subjectId : null,
        deviceId: principal.deviceId ?? (principal.kind === 'device' ? principal.subjectId : null),
      },
    };
  }

  run<T>(
    tenantId: string,
    actor: AuditActor,
    fn: (uow: TenantUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return this.uow.runAs(tenantId, actor, fn);
  }

  system<T>(tenantId: string, fn: (uow: TenantUnitOfWork) => Promise<T>): Promise<T> {
    return this.uow.runAs(tenantId, SYSTEM_ACTOR, fn);
  }
}
