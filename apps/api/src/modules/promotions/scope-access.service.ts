import { Injectable } from '@nestjs/common';
import type { TenantScopedDb } from '@pos/db';

import { AuthorizationService } from '../kernel/public/index.js';
import { HierarchyService } from '../tenancy/public/index.js';
import { PRICING_PERMISSIONS } from './permissions.js';

export interface ScopeTarget {
  readonly scopeKind: string;
  readonly scopeId?: string | null;
  readonly scopeValue?: string | null;
}

/**
 * Scope checks for writes. A price list or promotion applies wherever its assignments or scopes
 * point, so changing it needs the manage permission at every one of those targets:
 *
 * - `org_unit` / `location` targets must exist in the tenant (404 otherwise) and the caller must
 *   hold the permission at (or above) that node;
 * - tenant-wide targets (`tenant`, `channel`, `customer_group`, `customer`) and "no targets at
 *   all" need a tenant-level grant, because a narrower assignment cannot speak for the tenant.
 */
@Injectable()
export class ScopeAccessService {
  constructor(
    private readonly authz: AuthorizationService,
    private readonly hierarchy: HierarchyService,
  ) {}

  async assertManage(db: TenantScopedDb, targets: readonly ScopeTarget[]): Promise<void> {
    if (targets.length === 0) {
      await this.authz.assert(PRICING_PERMISSIONS.manage, { kind: 'tenant', id: db.tenantId });
      return;
    }
    for (const target of targets) {
      if ((target.scopeKind === 'org_unit' || target.scopeKind === 'location') && target.scopeId) {
        await this.hierarchy.requireScope(db, target.scopeKind, target.scopeId);
        await this.authz.assert(PRICING_PERMISSIONS.manage, {
          kind: target.scopeKind,
          id: target.scopeId,
        });
      } else {
        await this.authz.assert(PRICING_PERMISSIONS.manage, { kind: 'tenant', id: db.tenantId });
      }
    }
  }
}
