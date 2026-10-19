import { randomUUID } from 'node:crypto';

import { readInTenant, runInTenantTransaction, withTenant, withoutTenant } from '@pos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHierarchyFixture, createUserFixture, type HierarchyFixture } from './fixtures.js';
import { startPostgresWithSchema, type TestPostgres } from './postgres.js';

const PERMISSIONS = [
  {
    key: 'tenancy.location.view',
    module: 'tenancy',
    description: 'View locations',
    isSensitive: false,
  },
  { key: 'tenancy.admin', module: 'tenancy', description: 'Tenancy admin', isSensitive: true },
];
const ROLES = [
  {
    key: 'tenant_owner',
    name: 'Tenant owner',
    description: 'Everything',
    permissions: ['tenancy.location.view', 'tenancy.admin'],
  },
  {
    key: 'readonly_auditor',
    name: 'Read-only auditor',
    description: 'Views',
    permissions: ['tenancy.location.view'],
  },
];

/** Migration 0002: the schema gaps closed for F1 (docs/releases/f1.md). */
describe('migration 0002', () => {
  let db: TestPostgres;
  let a: HierarchyFixture;
  let b: HierarchyFixture;
  let ownerRoleId: string;
  let customRoleA: string;
  let customRoleB: string;

  beforeAll(async () => {
    db = await startPostgresWithSchema();
    a = await createHierarchyFixture(db.admin, 'tenant-a');
    b = await createHierarchyFixture(db.admin, 'tenant-b');
    await db.app.query('SELECT identity.fn_seed_access_catalog($1::jsonb, $2::jsonb)', [
      JSON.stringify(PERMISSIONS),
      JSON.stringify(ROLES),
    ]);
    ownerRoleId = (
      await db.admin.query<{ id: string }>(
        "SELECT id FROM identity.roles WHERE tenant_id IS NULL AND key = 'tenant_owner'",
      )
    ).rows[0]!.id;
    customRoleA = randomUUID();
    customRoleB = randomUUID();
    await db.admin.query(
      "INSERT INTO identity.roles (id, tenant_id, key, name) VALUES ($1, $2, 'custom', 'Custom A'), ($3, $4, 'custom', 'Custom B')",
      [customRoleA, a.tenantId, customRoleB, b.tenantId],
    );
    await db.admin.query(
      "INSERT INTO identity.role_permissions (role_id, permission_key) VALUES ($1, 'tenancy.location.view'), ($2, 'tenancy.location.view')",
      [customRoleA, customRoleB],
    );
  });

  afterAll(async () => {
    await db?.stop();
  });

  it('seed function is idempotent, creates system roles with tenant_id NULL and prunes removed permissions', async () => {
    await db.app.query('SELECT identity.fn_seed_access_catalog($1::jsonb, $2::jsonb)', [
      JSON.stringify(PERMISSIONS),
      JSON.stringify(ROLES),
    ]);
    const roles = await db.admin.query<{
      key: string;
      tenant_id: string | null;
      is_system: boolean;
    }>('SELECT key, tenant_id, is_system FROM identity.roles WHERE is_system ORDER BY key');
    expect(roles.rows).toEqual([
      { key: 'readonly_auditor', tenant_id: null, is_system: true },
      { key: 'tenant_owner', tenant_id: null, is_system: true },
    ]);
    const trimmed = [{ ...ROLES[0]!, permissions: ['tenancy.admin'] }, ROLES[1]!];
    await db.app.query('SELECT identity.fn_seed_access_catalog($1::jsonb, $2::jsonb)', [
      JSON.stringify(PERMISSIONS),
      JSON.stringify(trimmed),
    ]);
    const perms = await db.admin.query<{ permission_key: string }>(
      'SELECT permission_key FROM identity.role_permissions WHERE role_id = $1',
      [ownerRoleId],
    );
    expect(perms.rows.map((r) => r.permission_key)).toEqual(['tenancy.admin']);
    await db.app.query('SELECT identity.fn_seed_access_catalog($1::jsonb, $2::jsonb)', [
      JSON.stringify(PERMISSIONS),
      JSON.stringify(ROLES),
    ]);
  });

  it("C: tenant A reads system role permissions and its own custom role, never tenant B's", async () => {
    const visible = await readInTenant(db.app, a.tenantId, (t) =>
      t.query<{ role_id: string }>('SELECT DISTINCT role_id FROM identity.role_permissions'),
    );
    const ids = visible.map((r) => r.role_id);
    expect(ids).toContain(ownerRoleId);
    expect(ids).toContain(customRoleA);
    expect(ids).not.toContain(customRoleB);
  });

  it("C: tenant A cannot attach a permission to a system role or to tenant B's role (42501)", async () => {
    for (const roleId of [ownerRoleId, customRoleB]) {
      await expect(
        withTenant(db.app, a.tenantId, (c) =>
          c.query(
            "INSERT INTO identity.role_permissions (role_id, permission_key) VALUES ($1, 'tenancy.admin')",
            [roleId],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
    // and can manage its own custom role
    await withTenant(db.app, a.tenantId, (c) =>
      c.query(
        "INSERT INTO identity.role_permissions (role_id, permission_key) VALUES ($1, 'tenancy.admin')",
        [customRoleA],
      ),
    );
  });

  it("D: role_assignments may reference a system role or an own-tenant role, not another tenant's (23503)", async () => {
    const user = await createUserFixture(db.admin, a.tenantId);
    const insert = (roleId: string) =>
      withTenant(db.app, a.tenantId, (c) =>
        c.query(
          `INSERT INTO identity.role_assignments (tenant_id, user_id, role_id, scope_kind, scope_id)
           VALUES ($1, $2, $3, 'location', $4)`,
          [a.tenantId, user.userId, roleId, a.locationId],
        ),
      );
    await insert(ownerRoleId);
    await insert(customRoleA);
    await expect(insert(customRoleB)).rejects.toMatchObject({ code: '23503' });
    // even the superuser path is rejected by the trigger (it sees the row and compares tenants)
    await expect(
      db.admin.query(
        `INSERT INTO identity.role_assignments (tenant_id, user_id, role_id, scope_kind, scope_id) VALUES ($1, $2, $3, 'location', $4)`,
        [a.tenantId, user.userId, customRoleB, a.locationId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('E: scope_id must exist for its kind in the same tenant (23503)', async () => {
    const user = await createUserFixture(db.admin, a.tenantId);
    const insert = (kind: string, scopeId: string) =>
      withTenant(db.app, a.tenantId, (c) =>
        c.query(
          `INSERT INTO identity.role_assignments (tenant_id, user_id, role_id, scope_kind, scope_id) VALUES ($1, $2, $3, $4, $5)`,
          [a.tenantId, user.userId, ownerRoleId, kind, scopeId],
        ),
      );
    await insert('tenant', a.tenantId);
    await insert('org_unit', a.childOrgUnitId);
    await insert('register', a.registerId);
    await expect(insert('location', b.locationId)).rejects.toMatchObject({ code: '23503' });
    await expect(insert('location', a.registerId)).rejects.toMatchObject({ code: '23503' });
    await expect(insert('tenant', b.tenantId)).rejects.toMatchObject({ code: '23503' });
    await expect(
      withTenant(db.app, a.tenantId, (c) =>
        c.query(
          `INSERT INTO tenancy.config_entries (tenant_id, scope_kind, scope_id, key, value, version) VALUES ($1, 'location', $2, 'k', '1', 1)`,
          [a.tenantId, b.locationId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('F: fn_scope_path returns register → department → location → org chain → tenant, nearest first', async () => {
    const path = await readInTenant(db.app, a.tenantId, (t) =>
      t.query<{ kind: string; id: string; ord: number }>(
        "SELECT kind, id, ord FROM tenancy.fn_scope_path('register', $1) ORDER BY ord",
        [a.registerId],
      ),
    );
    expect(path.map((p) => [p.kind, p.id])).toEqual([
      ['register', a.registerId],
      ['department', a.departmentId],
      ['location', a.locationId],
      ['org_unit', a.childOrgUnitId],
      ['org_unit', a.rootOrgUnitId],
      ['tenant', a.tenantId],
    ]);
    const other = await readInTenant(db.app, a.tenantId, (t) =>
      t.query<{ kind: string }>(
        "SELECT kind FROM tenancy.fn_scope_path('location', $1) ORDER BY ord",
        [a.otherLocationId],
      ),
    );
    expect(other.map((p) => p.kind)).toEqual(['location', 'org_unit', 'tenant']);
    const foreign = await readInTenant(db.app, a.tenantId, (t) =>
      t.query("SELECT * FROM tenancy.fn_scope_path('register', $1)", [b.registerId]),
    );
    expect(foreign).toHaveLength(0);
    const noContext = await withoutTenant(db.app, (c) =>
      c.query("SELECT * FROM tenancy.fn_scope_path('register', $1)", [a.registerId]),
    );
    expect(noContext.rows).toHaveLength(0);
  });

  it('B: reparenting an org unit under its own descendant raises 23514 and leaves paths unchanged', async () => {
    const before = await db.admin.query(
      'SELECT ancestor_id, descendant_id, depth FROM tenancy.org_unit_paths WHERE tenant_id = $1 ORDER BY 1, 2',
      [a.tenantId],
    );
    await expect(
      withTenant(db.app, a.tenantId, (c) =>
        c.query('UPDATE tenancy.org_units SET parent_id = $1 WHERE id = $2', [
          a.childOrgUnitId,
          a.rootOrgUnitId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      withTenant(db.app, a.tenantId, (c) =>
        c.query('UPDATE tenancy.org_units SET parent_id = $1 WHERE id = $1', [a.childOrgUnitId]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const after = await db.admin.query(
      'SELECT ancestor_id, descendant_id, depth FROM tenancy.org_unit_paths WHERE tenant_id = $1 ORDER BY 1, 2',
      [a.tenantId],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('B: a legal reparent rewrites the closure for the whole subtree', async () => {
    const grandchild = randomUUID();
    await withTenant(db.app, a.tenantId, (c) =>
      c.query(
        "INSERT INTO tenancy.org_units (id, tenant_id, parent_id, kind, code, name) VALUES ($1, $2, $3, 'division', 'gc', 'Grandchild')",
        [grandchild, a.tenantId, a.childOrgUnitId],
      ),
    );
    await withTenant(db.app, a.tenantId, (c) =>
      c.query('UPDATE tenancy.org_units SET parent_id = $1 WHERE id = $2', [
        a.rootOrgUnitId,
        grandchild,
      ]),
    );
    const paths = await db.admin.query<{ ancestor_id: string; depth: number }>(
      'SELECT ancestor_id, depth FROM tenancy.org_unit_paths WHERE descendant_id = $1 ORDER BY depth',
      [grandchild],
    );
    expect(paths.rows).toEqual([
      { ancestor_id: grandchild, depth: 0 },
      { ancestor_id: a.rootOrgUnitId, depth: 1 },
    ]);
  });

  it('G: the outbox relay claims rows across tenants without a tenant context, with a lease', async () => {
    for (const fx of [a, b]) {
      await runInTenantTransaction(db.app, fx.tenantId, async (uow) => {
        uow.emit({
          type: 'location.created',
          aggregateKind: 'location',
          aggregateId: fx.locationId,
          payload: { code: 'x' },
        });
      });
    }
    const first = await withoutTenant(db.app, (c) =>
      c.query<{ id: string; tenant_id: string; attempts: number }>(
        'SELECT * FROM audit.fn_claim_outbox_batch(10, 10)',
      ),
    );
    expect(new Set(first.rows.map((r) => r.tenant_id))).toEqual(new Set([a.tenantId, b.tenantId]));
    expect(first.rows.every((r) => r.attempts === 1)).toBe(true);
    const second = await withoutTenant(db.app, (c) =>
      c.query('SELECT * FROM audit.fn_claim_outbox_batch(10, 10)'),
    );
    expect(second.rows).toHaveLength(0); // leased for 60 s
    const ids = first.rows.map((r) => r.id);
    const published = await withoutTenant(db.app, (c) =>
      c.query<{ n: number }>('SELECT audit.fn_mark_outbox_published($1::uuid[]) AS n', [ids]),
    );
    expect(published.rows[0]!.n).toBe(ids.length);
    const left = await db.admin.query(
      'SELECT 1 FROM audit.outbox_events WHERE published_at IS NULL',
    );
    expect(left.rows).toHaveLength(0);
  });

  it('grants: app_rw cannot write identity.permissions or platform.tenants directly but can provision through the function', async () => {
    await expect(
      db.app.query(
        "INSERT INTO identity.permissions (key, module, description) VALUES ('x.y', 'x', 'd')",
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      db.app.query("INSERT INTO platform.tenants (slug, name) VALUES ('evil', 'Evil')"),
    ).rejects.toMatchObject({ code: '42501' });
    const id = randomUUID();
    const provisioned = await db.app.query<{ id: string }>(
      "SELECT platform.fn_provision_tenant($1, 'tenant-c', 'Tenant C', NULL, NULL, NULL, NULL) AS id",
      [id],
    );
    expect(provisioned.rows[0]!.id).toBe(id);
    const activated = await db.app.query<{ ok: boolean }>(
      'SELECT platform.fn_activate_tenant($1) AS ok',
      [id],
    );
    expect(activated.rows[0]!.ok).toBe(true);
    const status = await db.admin.query<{ status: string }>(
      'SELECT status FROM platform.tenants WHERE id = $1',
      [id],
    );
    expect(status.rows[0]!.status).toBe('active');
  });

  it('I: only one open business day per location', async () => {
    await withTenant(db.app, a.tenantId, (c) =>
      c.query(
        "INSERT INTO tenancy.business_days (tenant_id, location_id, business_date) VALUES ($1, $2, '2026-10-18')",
        [a.tenantId, a.locationId],
      ),
    );
    await expect(
      withTenant(db.app, a.tenantId, (c) =>
        c.query(
          "INSERT INTO tenancy.business_days (tenant_id, location_id, business_date) VALUES ($1, $2, '2026-10-19')",
          [a.tenantId, a.locationId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
