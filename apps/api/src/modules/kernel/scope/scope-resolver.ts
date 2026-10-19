import type { Scope, ScopeKind } from '@pos/auth';

import type { ResolvedScope } from '../request-context.js';

/** Everything under a scope, for principals that carry explicit coveredScopeIds (devices, API clients). */
export interface ExpandedScope {
  readonly orgUnitIds: readonly string[];
  readonly locationIds: readonly string[];
  readonly registerIds: readonly string[];
}

/** Implemented by the tenancy module (tenancy.fn_scope_path + closure table). null = unknown or foreign id. */
export interface ScopeResolver {
  resolve(tenantId: string, kind: ScopeKind, id: string): Promise<ResolvedScope | null>;
  expand(tenantId: string, scope: Scope): Promise<ExpandedScope | null>;
}
