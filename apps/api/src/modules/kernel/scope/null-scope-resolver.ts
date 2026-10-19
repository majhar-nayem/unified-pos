import type { ResolvedScope } from '../request-context.js';
import type { ExpandedScope, ScopeResolver } from './scope-resolver.js';

/** Default binding until the tenancy module provides one: nothing resolves, so scoped routes 404. */
export class NullScopeResolver implements ScopeResolver {
  async resolve(): Promise<ResolvedScope | null> {
    return null;
  }

  async expand(): Promise<ExpandedScope | null> {
    return null;
  }
}
