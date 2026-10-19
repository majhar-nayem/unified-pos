import { Injectable } from '@nestjs/common';
import { type AttributeValue, type Decision, type PermissionKey, type Scope, can } from '@pos/auth';

import { isOperator } from '../auth/authenticator.js';
import {
  ForbiddenError,
  LimitExceededError,
  NotFoundError,
  UnauthorizedError,
} from '../errors/errors.js';
import { KernelPorts } from '../ports.js';
import { RequestContextService, type ResolvedScope } from '../request-context.js';

export type Attributes = Readonly<Record<string, AttributeValue>>;

/**
 * AuthZ (docs/01 §5.1 step 5), called from application services — never from controllers — so
 * jobs and sync go through the same check. Evaluates the principal against the target scope and
 * each of its ancestors (tenant-wide roles never materialise id lists).
 */
@Injectable()
export class AuthorizationService {
  constructor(
    private readonly context: RequestContextService,
    private readonly ports: KernelPorts,
  ) {}

  async can(permission: PermissionKey, scope?: Scope, attributes?: Attributes): Promise<Decision> {
    const ctx = this.context.require();
    const principal = ctx.principal;
    if (!principal) throw new UnauthorizedError();
    if (isOperator(principal)) return { allowed: true, reason: 'granted' };

    const resolved = await this.resolveScope(principal.tenantId, scope, ctx.scope);
    if (!resolved) return { allowed: false, reason: 'out_of_scope' };

    let best: Decision | undefined;
    for (const candidate of resolved.path) {
      const decision = can(principal, permission, candidate, attributes ? { attributes } : {});
      if (decision.allowed) return decision;
      best = better(best, decision);
    }
    return best ?? { allowed: false, reason: 'no_assignment' };
  }

  /**
   * True when any of the principal's assignments grants the permission at its own scope. For
   * tenant-level collections that are filtered by data rather than hierarchy (users, roles, devices).
   */
  canAnywhere(permission: PermissionKey, attributes?: Attributes): boolean {
    const principal = this.context.require().principal;
    if (!principal) throw new UnauthorizedError();
    if (isOperator(principal)) return true;
    return principal.assignments.some(
      (a) => can(principal, permission, a.scope, attributes ? { attributes } : {}).allowed,
    );
  }

  assertAnywhere(permission: PermissionKey, attributes?: Attributes): void {
    if (!this.canAnywhere(permission, attributes))
      throw new ForbiddenError('PERMISSION_DENIED', `Missing permission ${permission}`);
  }

  /** Throws the mapped error when not allowed; returns the granting decision otherwise. */
  async assert(
    permission: PermissionKey,
    scope?: Scope,
    attributes?: Attributes,
  ): Promise<Decision> {
    const decision = await this.can(permission, scope, attributes);
    if (decision.allowed) return decision;
    switch (decision.reason) {
      case 'out_of_scope':
        throw new NotFoundError();
      case 'limit_exceeded':
        throw new LimitExceededError(decision.limit!);
      case 'expired':
        throw new ForbiddenError(
          'ASSIGNMENT_EXPIRED',
          'The granting assignment is not currently valid',
        );
      default:
        throw new ForbiddenError('PERMISSION_DENIED', `Missing permission ${permission}`);
    }
  }

  private async resolveScope(
    tenantId: string,
    scope: Scope | undefined,
    current: ResolvedScope | undefined,
  ): Promise<ResolvedScope | null> {
    if (!scope) {
      if (current) return current;
      return { kind: 'tenant', id: tenantId, path: [{ kind: 'tenant', id: tenantId }] };
    }
    if (scope.kind === 'tenant') {
      return scope.id === tenantId
        ? { kind: 'tenant', id: tenantId, path: [{ kind: 'tenant', id: tenantId }] }
        : null;
    }
    if (current && current.id === scope.id && current.kind === scope.kind) return current;
    return this.ports.scopeResolver.resolve(tenantId, scope.kind, scope.id);
  }
}

const RANK: Record<Decision['reason'], number> = {
  granted: 5,
  limit_exceeded: 4,
  expired: 3,
  out_of_scope: 2,
  no_assignment: 1,
};

function better(a: Decision | undefined, b: Decision): Decision {
  if (!a) return b;
  return RANK[b.reason] > RANK[a.reason] ? b : a;
}
