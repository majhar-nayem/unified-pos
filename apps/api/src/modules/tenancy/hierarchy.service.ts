import { Injectable } from '@nestjs/common';
import type { Principal, Scope, ScopeKind } from '@pos/auth';
import type { TenantScopedDb } from '@pos/db';

import {
  type ExpandedScope,
  NotFoundError,
  type ResolvedScope,
  type ScopeResolver,
  UnitOfWork,
  principalReaches,
} from '../kernel/public/index.js';

/**
 * Hierarchy queries over tenancy.org_unit_paths (closure) + locations + registers.
 * Bound as KernelPorts.scopeResolver by the composition root, so the ScopeGuard and AuthorizationService use it.
 */
@Injectable()
export class HierarchyService implements ScopeResolver {
  constructor(private readonly uow: UnitOfWork) {}

  async resolve(tenantId: string, kind: ScopeKind, id: string): Promise<ResolvedScope | null> {
    return this.uow.readAs(tenantId, (db) => scopePath(db, kind, id));
  }

  async expand(tenantId: string, scope: Scope): Promise<ExpandedScope | null> {
    return this.uow.readAs(tenantId, (db) => expandScope(db, scope));
  }

  /** Resolve or 404 inside an existing tenant transaction / read. */
  async requireScope(db: TenantScopedDb, kind: ScopeKind, id: string): Promise<ResolvedScope> {
    const resolved = await scopePath(db, kind, id);
    if (!resolved) throw new NotFoundError();
    return resolved;
  }
}

/** register → department → location → org-unit chain → tenant (nearest first); null when unknown/foreign. */
export async function scopePath(
  db: TenantScopedDb,
  kind: ScopeKind,
  id: string,
): Promise<ResolvedScope | null> {
  if (kind === 'tenant') {
    return id === db.tenantId ? { kind, id, path: [{ kind: 'tenant', id }] } : null;
  }
  const rows = await db.query<{ kind: ScopeKind; id: string; ord: number }>(
    'SELECT kind, id, ord FROM tenancy.fn_scope_path($1, $2) ORDER BY ord',
    [kind, id],
  );
  if (rows.length === 0) return null;
  return { kind, id, path: rows.map((r) => ({ kind: r.kind, id: r.id })) };
}

export async function expandScope(db: TenantScopedDb, scope: Scope): Promise<ExpandedScope | null> {
  const t = db.tenantId;
  switch (scope.kind) {
    case 'tenant': {
      if (scope.id !== t) return null;
      const [ou, loc, reg] = await Promise.all([
        db.query<{ id: string }>('SELECT id FROM tenancy.org_units WHERE tenant_id = $1', [t]),
        db.query<{ id: string }>('SELECT id FROM tenancy.locations WHERE tenant_id = $1', [t]),
        db.query<{ id: string }>('SELECT id FROM tenancy.registers WHERE tenant_id = $1', [t]),
      ]);
      return { orgUnitIds: ids(ou), locationIds: ids(loc), registerIds: ids(reg) };
    }
    case 'org_unit': {
      const ou = await db.query<{ id: string }>(
        'SELECT descendant_id AS id FROM tenancy.org_unit_paths WHERE tenant_id = $1 AND ancestor_id = $2',
        [t, scope.id],
      );
      if (ou.length === 0) return null;
      const loc = await db.query<{ id: string }>(
        `SELECT id FROM tenancy.locations WHERE tenant_id = $1 AND org_unit_id = ANY($2::uuid[])`,
        [t, ids(ou)],
      );
      const reg = await db.query<{ id: string }>(
        'SELECT id FROM tenancy.registers WHERE tenant_id = $1 AND location_id = ANY($2::uuid[])',
        [t, ids(loc)],
      );
      return { orgUnitIds: ids(ou), locationIds: ids(loc), registerIds: ids(reg) };
    }
    case 'location': {
      const loc = await db.query<{ id: string }>(
        'SELECT id FROM tenancy.locations WHERE tenant_id = $1 AND id = $2',
        [t, scope.id],
      );
      if (loc.length === 0) return null;
      const reg = await db.query<{ id: string }>(
        'SELECT id FROM tenancy.registers WHERE tenant_id = $1 AND location_id = $2',
        [t, scope.id],
      );
      return { orgUnitIds: [], locationIds: [scope.id], registerIds: ids(reg) };
    }
    case 'department': {
      const dep = await db.query<{ location_id: string }>(
        'SELECT location_id FROM tenancy.departments WHERE tenant_id = $1 AND id = $2',
        [t, scope.id],
      );
      if (dep.length === 0) return null;
      const reg = await db.query<{ id: string }>(
        'SELECT id FROM tenancy.registers WHERE tenant_id = $1 AND department_id = $2',
        [t, scope.id],
      );
      return { orgUnitIds: [], locationIds: [], registerIds: ids(reg) };
    }
    case 'register': {
      const reg = await db.query<{ location_id: string }>(
        'SELECT location_id FROM tenancy.registers WHERE tenant_id = $1 AND id = $2',
        [t, scope.id],
      );
      if (reg.length === 0) return null;
      return { orgUnitIds: [], locationIds: [], registerIds: [scope.id] };
    }
  }
}

/** Filter rows with precomputed ancestor ids by what the principal can reach (list endpoints). */
export function reachable<T extends { id: string; ancestorIds: readonly string[] }>(
  principal: Principal,
  kind: ScopeKind,
  rows: readonly T[],
): T[] {
  return rows.filter((row) =>
    principalReaches(principal, {
      kind,
      id: row.id,
      path: [
        { kind, id: row.id },
        ...row.ancestorIds.map((id) => ({ kind: 'org_unit' as const, id })),
      ],
    }),
  );
}

function ids(rows: readonly { id: string }[]): string[] {
  return rows.map((r) => r.id);
}
