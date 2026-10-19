import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { Scope } from '@pos/auth';
import type { NextFunction, Request, Response } from 'express';

import type { AuthenticatedPrincipal } from './auth/authenticator.js';

export interface ResolvedScope {
  readonly kind: Scope['kind'];
  readonly id: string;
  /** Target first, then its ancestors up to the tenant (tenancy.fn_scope_path order). */
  readonly path: readonly Scope[];
}

export interface RequestContext {
  readonly correlationId: string;
  readonly startedAt: number;
  readonly ip?: string;
  readonly userAgent?: string;
  principal?: AuthenticatedPrincipal;
  tenantId?: string;
  scope?: ResolvedScope;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Per-request context propagated through AsyncLocalStorage (also used by the pino mixin). */
@Injectable()
export class RequestContextService {
  run<T>(ctx: RequestContext, fn: () => T): T {
    return storage.run(ctx, fn);
  }

  current(): RequestContext | undefined {
    return storage.getStore();
  }

  require(): RequestContext {
    const ctx = storage.getStore();
    if (!ctx)
      throw new Error('No request context; are you inside a request or UnitOfWork.runAs()?');
    return ctx;
  }

  /** Fields the logger mixes into every line. */
  static logFields(): Record<string, unknown> {
    const ctx = storage.getStore();
    if (!ctx) return {};
    const principal = ctx.principal;
    return {
      correlationId: ctx.correlationId,
      ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
      ...(principal
        ? principal.kind === 'operator'
          ? { principalKind: 'operator', principalId: principal.operatorId }
          : { principalKind: principal.kind, principalId: principal.subjectId }
        : {}),
    };
  }
}

export const CORRELATION_HEADER = 'x-correlation-id';
const CORRELATION_ID = /^[A-Za-z0-9._:-]{8,128}$/;

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly context: RequestContextService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header(CORRELATION_HEADER);
    const correlationId = incoming && CORRELATION_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader(CORRELATION_HEADER, correlationId);
    const ctx: RequestContext = {
      correlationId,
      startedAt: Date.now(),
      ...(req.ip ? { ip: req.ip } : {}),
      ...(req.header('user-agent') ? { userAgent: req.header('user-agent') } : {}),
    };
    this.context.run(ctx, () => next());
  }
}
