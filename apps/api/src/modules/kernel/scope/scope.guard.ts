import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Principal, ScopeKind } from '@pos/auth';
import { isUuid } from '@pos/db';
import type { Request } from 'express';

import { isOperator } from '../auth/authenticator.js';
import { getContract, type ScopeSpec } from '../contract/contract.js';
import { NotFoundError } from '../errors/errors.js';
import { KernelPorts } from '../ports.js';
import { RequestContextService, type ResolvedScope } from '../request-context.js';

/**
 * Scope resolution (docs/01 §5.1 step 4): the location/register/org unit in the path must exist
 * in the caller's tenant and sit under one of the caller's assignments; otherwise 404.
 */
@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly context: RequestContextService,
    private readonly ports: KernelPorts,
  ) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    const contract = getContract(this.reflector, execution.getHandler());
    const spec = contract?.scope;
    if (!spec) return true;
    const ctx = this.context.require();
    const principal = ctx.principal;
    if (!principal || isOperator(principal)) return true; // operators are checked by AuthGuard
    const req = execution.switchToHttp().getRequest<Request>();
    const tenantId = principal.tenantId;

    const target = readTarget(spec, req, tenantId);
    if (!target) throw new NotFoundError();

    // Tenant-level resources (users, roles, legal entities…) are not in the location hierarchy:
    // RLS and the service's permission check protect them; the guard only pins the tenant scope.
    if (target.kind === 'tenant') {
      ctx.scope = { kind: 'tenant', id: tenantId, path: [{ kind: 'tenant', id: tenantId }] };
      return true;
    }
    const resolved = await this.ports.scopeResolver.resolve(tenantId, target.kind, target.id);
    if (!resolved) throw new NotFoundError();
    if (!principalReaches(principal, resolved)) throw new NotFoundError();
    ctx.scope = resolved;
    return true;
  }
}

function readTarget(
  spec: ScopeSpec,
  req: Request,
  tenantId: string,
): { kind: ScopeKind; id: string } | null {
  if (spec.kind === 'tenant') return { kind: 'tenant', id: tenantId };
  if (spec.kind === 'dynamic') {
    const source = (spec.from === 'body' ? req.body : req.query) as
      Record<string, unknown> | undefined;
    const kind = spec.scopeKind ?? (spec.kindField ? pick(source, spec.kindField) : undefined);
    const id = pick(source, spec.idField);
    if (typeof kind !== 'string' || typeof id !== 'string' || !isUuid(id)) return null;
    if (!['tenant', 'org_unit', 'location', 'department', 'register'].includes(kind)) return null;
    if (kind === 'tenant' && id !== tenantId) return null;
    return { kind: kind as ScopeKind, id };
  }
  const id = req.params[spec.param];
  if (typeof id !== 'string' || !isUuid(id)) return null;
  return { kind: spec.kind, id };
}

/** An assignment on the target or any ancestor (or tenant-wide) reaches the target. */
export function principalReaches(principal: Principal, scope: ResolvedScope): boolean {
  const pathIds = new Set(scope.path.map((s) => s.id));
  return principal.assignments.some(
    (a) =>
      a.scope.kind === 'tenant' || pathIds.has(a.scope.id) || a.coveredScopeIds.includes(scope.id),
  );
}

/** Dotted path lookup in an unvalidated query/body object (`scope.id`). */
function pick(source: Record<string, unknown> | undefined, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined,
      source,
    );
}
