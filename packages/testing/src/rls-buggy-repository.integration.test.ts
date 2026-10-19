import { type TenantScopedDb, runInTenantTransaction } from '@pos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHierarchyFixture, type HierarchyFixture } from './fixtures.js';
import { startPostgresWithSchema, type TestPostgres } from './postgres.js';

/** A repository that forgot every tenant predicate: RLS must still contain it (F1 acceptance). */
class BuggyLocationRepository {
  constructor(private readonly db: TenantScopedDb) {}

  findById(id: string) {
    return this.db.maybeOne<{ id: string; tenant_id: string }>(
      'SELECT id, tenant_id FROM tenancy.locations WHERE id = $1',
      [id],
    );
  }

  listAll() {
    return this.db.query<{ id: string }>('SELECT id FROM tenancy.locations');
  }

  insertForTenant(tenantId: string, orgUnitId: string) {
    return this.db.query(
      `INSERT INTO tenancy.locations (tenant_id, org_unit_id, code, name, kind, timezone, currency)
       VALUES ($1, $2, 'smuggled', 'Smuggled', 'store', 'UTC', 'AUD')`,
      [tenantId, orgUnitId],
    );
  }

  renameEverything() {
    return this.db.query("UPDATE tenancy.locations SET name = 'pwned'");
  }
}

describe('RLS blocks a deliberately buggy repository', () => {
  let db: TestPostgres;
  let a: HierarchyFixture;
  let b: HierarchyFixture;

  beforeAll(async () => {
    db = await startPostgresWithSchema();
    a = await createHierarchyFixture(db.admin, 'buggy-a');
    b = await createHierarchyFixture(db.admin, 'buggy-b');
  });

  afterAll(async () => {
    await db?.stop();
  });

  it('reads without a tenant predicate still see only the current tenant', async () => {
    await runInTenantTransaction(db.app, a.tenantId, async (uow) => {
      const repo = new BuggyLocationRepository(uow.db);
      expect(await repo.findById(b.locationId)).toBeNull();
      expect((await repo.findById(a.locationId))?.tenant_id).toBe(a.tenantId);
      const ids = (await repo.listAll()).map((r) => r.id).sort();
      expect(ids).toEqual([a.locationId, a.otherLocationId].sort());
    });
  });

  it('an insert stamped with another tenant id is rejected (42501), even with a valid parent', async () => {
    await expect(
      runInTenantTransaction(db.app, a.tenantId, (uow) =>
        new BuggyLocationRepository(uow.db).insertForTenant(b.tenantId, b.rootOrgUnitId),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('a predicate-less UPDATE only touches the current tenant', async () => {
    await runInTenantTransaction(db.app, a.tenantId, (uow) =>
      new BuggyLocationRepository(uow.db).renameEverything(),
    );
    const names = await db.admin.query<{ tenant_id: string; name: string }>(
      'SELECT tenant_id, name FROM tenancy.locations ORDER BY tenant_id',
    );
    expect(
      names.rows.filter((r) => r.tenant_id === a.tenantId).every((r) => r.name === 'pwned'),
    ).toBe(true);
    expect(
      names.rows.filter((r) => r.tenant_id === b.tenantId).every((r) => r.name !== 'pwned'),
    ).toBe(true);
  });

  it('the handle is bound to one tenant: there is no API to switch, and a stale handle outside its transaction fails', async () => {
    let escaped: TenantScopedDb | undefined;
    await runInTenantTransaction(db.app, a.tenantId, async (uow) => {
      escaped = uow.db;
    });
    expect(escaped!.tenantId).toBe(a.tenantId);
    expect(Object.keys(escaped!)).not.toContain('setTenant');
    // the pooled client was released; using the handle afterwards must not silently run outside RLS
    await expect(escaped!.query('SELECT 1')).rejects.toThrow();
  });
});
