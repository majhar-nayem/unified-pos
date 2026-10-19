import { randomUUID } from 'node:crypto';

import { withTenant, withoutTenant } from '@pos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTenantFixture, type TenantFixture } from './fixtures.js';
import { startPostgresWithSchema, type TestPostgres } from './postgres.js';

/**
 * Proves the two database-level isolation layers from docs/01-system-architecture.md §6.2:
 *   1. Row-Level Security keyed on app.tenant_id (tenant A never sees tenant B; no context → no rows)
 *   2. Composite (tenant_id, id) foreign keys reject references that cross tenants.
 */
describe('tenant isolation (postgres:16 + migration 0001)', () => {
  let db: TestPostgres;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

  beforeAll(async () => {
    db = await startPostgresWithSchema();
    tenantA = await createTenantFixture(db.admin, 'tenant-a');
    tenantB = await createTenantFixture(db.admin, 'tenant-b');
  });

  afterAll(async () => {
    await db?.stop();
  });

  it('applied the schema: 150+ tables and RLS forced on tenant tables', async () => {
    const tables = await db.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.tables
       WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('public', 'pg_catalog', 'information_schema')`,
    );
    expect(Number(tables.rows[0]!.n)).toBeGreaterThanOrEqual(150);

    const rls = await db.admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'tenancy' AND c.relname = 'legal_entities'`,
    );
    expect(rls.rows[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });

    const migrations = await db.admin.query<{ id: string }>(
      'SELECT id FROM public.schema_migrations ORDER BY id',
    );
    // 0001 = canonical db/schema*.sql, 0002 = F1, 0003 = F2 catalog/tax. Later slices append here.
    expect(migrations.rows.map((r) => r.id)).toEqual(['0001', '0002', '0003']);
  });

  it('tenant A sees only its own rows', async () => {
    const rows = await withTenant(db.app, tenantA.tenantId, async (client) => {
      const result = await client.query<{ id: string; tenant_id: string }>(
        'SELECT id, tenant_id FROM tenancy.legal_entities',
      );
      return result.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: tenantA.legalEntityId, tenant_id: tenantA.tenantId });
  });

  it('tenant B sees only its own rows, even when filtering by tenant A ids', async () => {
    const rows = await withTenant(db.app, tenantB.tenantId, async (client) => {
      const result = await client.query('SELECT id FROM tenancy.legal_entities WHERE id = $1', [
        tenantA.legalEntityId,
      ]);
      return result.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('a missing app.tenant_id yields zero rows (fail closed), not an error', async () => {
    const rows = await withoutTenant(db.app, async (client) => {
      const result = await client.query('SELECT id FROM tenancy.legal_entities');
      return result.rows;
    });
    expect(rows).toHaveLength(0);

    // The superuser fixture connection is not subject to RLS: both tenants' rows exist.
    const all = await db.admin.query('SELECT id FROM tenancy.legal_entities');
    expect(all.rows).toHaveLength(2);
  });

  it('tenant A cannot insert a row stamped with tenant B (WITH CHECK)', async () => {
    await expect(
      withTenant(db.app, tenantA.tenantId, (client) =>
        client.query(
          'INSERT INTO tenancy.legal_entities (tenant_id, name, country_code) VALUES ($1, $2, $3)',
          [tenantB.tenantId, 'Smuggled', 'AU'],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' }); // insufficient_privilege: new row violates row-level security policy
  });

  it("composite tenant FK rejects a reference to another tenant's row", async () => {
    // tenancy.org_units(tenant_id, legal_entity_id) → tenancy.legal_entities(tenant_id, id).
    // Tenant A pointing at tenant B's legal entity has no matching (A, idB) pair: 23503 foreign_key_violation.
    // FK checks run with the table owner's rights, so this is the constraint, not RLS, rejecting it.
    await expect(
      withTenant(db.app, tenantA.tenantId, (client) =>
        client.query(
          `INSERT INTO tenancy.org_units (tenant_id, kind, code, name, legal_entity_id)
           VALUES ($1, 'company', 'hq', 'HQ', $2)`,
          [tenantA.tenantId, tenantB.legalEntityId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });

    // Same insert as superuser (no RLS at all) is rejected the same way.
    await expect(
      db.admin.query(
        `INSERT INTO tenancy.org_units (tenant_id, kind, code, name, legal_entity_id)
         VALUES ($1, 'company', 'hq', 'HQ', $2)`,
        [tenantA.tenantId, tenantB.legalEntityId],
      ),
    ).rejects.toMatchObject({ code: '23503' });

    // And the same-tenant reference succeeds.
    const inserted = await withTenant(db.app, tenantA.tenantId, async (client) => {
      const id = randomUUID();
      await client.query(
        `INSERT INTO tenancy.org_units (id, tenant_id, kind, code, name, legal_entity_id)
         VALUES ($1, $2, 'company', 'hq', 'HQ', $3)`,
        [id, tenantA.tenantId, tenantA.legalEntityId],
      );
      return id;
    });
    expect(inserted).toBeTruthy();
  });
});
