import { randomUUID } from 'node:crypto';

import { readInTenant, runInTenantTransaction } from '@pos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHierarchyFixture, type HierarchyFixture } from './fixtures.js';
import { createCatalogFixture } from './catalog-fixtures.js';
import { startPostgresWithSchema, type TestPostgres } from './postgres.js';

/** Migration 0003 (F2): search vectors, version columns, import jobs under RLS, the tenant-pinned search function. */
describe('migration 0003', () => {
  let db: TestPostgres;
  let a: HierarchyFixture;
  let b: HierarchyFixture;

  beforeAll(async () => {
    db = await startPostgresWithSchema();
    a = await createHierarchyFixture(db.admin, 'm3-a');
    b = await createHierarchyFixture(db.admin, 'm3-b');
    await createCatalogFixture(db.admin, a);
    await createCatalogFixture(db.admin, b);
  });

  afterAll(async () => {
    await db?.stop();
  });

  it('adds version columns used for If-Match', async () => {
    const result = await db.admin.query(
      `SELECT table_schema || '.' || table_name AS t FROM information_schema.columns
       WHERE column_name = 'version' AND table_schema IN ('catalog', 'pricing') ORDER BY 1`,
    );
    const tables = result.rows.map((r) => r.t);
    for (const table of [
      'catalog.categories',
      'catalog.tax_classes',
      'catalog.suppliers',
      'pricing.tax_rules',
      'catalog.items',
      'catalog.item_variants',
      'catalog.menus',
    ])
      expect(tables).toContain(table);
  });

  it('keeps items.search_vector current when the item, a variant or a barcode changes', async () => {
    const match = async (tenant: string, term: string) =>
      (
        await db.admin.query(
          "SELECT 1 FROM catalog.items WHERE tenant_id = $1 AND search_vector @@ plainto_tsquery('simple', $2)",
          [tenant, term],
        )
      ).rowCount;
    expect(await match(a.tenantId, 'cola')).toBe(1);
    await db.admin.query(
      "UPDATE catalog.items SET name = 'Fixture lemonade' WHERE tenant_id = $1",
      [a.tenantId],
    );
    expect(await match(a.tenantId, 'cola')).toBe(0);
    expect(await match(a.tenantId, 'lemonade')).toBe(1);
    const variant = (
      await db.admin.query<{ id: string }>(
        'SELECT id FROM catalog.item_variants WHERE tenant_id = $1 LIMIT 1',
        [a.tenantId],
      )
    ).rows[0]!;
    await db.admin.query("UPDATE catalog.item_variants SET sku = 'ZZ-UNIQUE-SKU' WHERE id = $1", [
      variant.id,
    ]);
    expect(await match(a.tenantId, 'ZZ-UNIQUE-SKU')).toBe(1);
    await db.admin.query(
      "INSERT INTO catalog.barcodes (tenant_id, variant_id, code) VALUES ($1, $2, '9399999999990')",
      [a.tenantId, variant.id],
    );
    expect(await match(a.tenantId, '9399999999990')).toBe(1);
    await db.admin.query("DELETE FROM catalog.barcodes WHERE code = '9399999999990'");
    expect(await match(a.tenantId, '9399999999990')).toBe(0);
    expect(await match(b.tenantId, 'lemonade')).toBe(0);
  });

  it('catalog.import_jobs forces row level security like every tenant table', async () => {
    const policy = await db.admin.query(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'catalog.import_jobs'::regclass",
    );
    expect(policy.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const seenByA = await readInTenant(db.app, a.tenantId, (tx) =>
      tx.query('SELECT id FROM catalog.import_jobs'),
    );
    const seenByB = await readInTenant(db.app, b.tenantId, (tx) =>
      tx.query('SELECT id FROM catalog.import_jobs'),
    );
    expect(seenByA).toHaveLength(1);
    expect(seenByB).toHaveLength(1);
    expect(seenByA[0]!.id).not.toBe(seenByB[0]!.id);
    await expect(
      runInTenantTransaction(db.app, a.tenantId, (uow) =>
        uow.db.query(
          "INSERT INTO catalog.import_jobs (id, tenant_id, file_name, status, report_csv) VALUES ($1, $2, 'x', 'rejected', '')",
          [randomUUID(), b.tenantId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('fn_search_items is pinned to the session tenant: no tenant, no rows; never another tenant’s rows', async () => {
    const search = (tenant: string | null, q: string) =>
      db.app.connect().then(async (client) => {
        try {
          await client.query('BEGIN');
          if (tenant) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
          const r = await client.query(
            'SELECT id, text_rank, similarity, score FROM catalog.fn_search_items($1, 10)',
            [q],
          );
          await client.query('ROLLBACK');
          return r.rows;
        } finally {
          client.release();
        }
      });
    expect((await search(a.tenantId, 'lemonade')).length).toBe(1);
    expect((await search(a.tenantId, 'lemonad')).length).toBe(1); // typo: word similarity
    expect(await search(null, 'lemonade')).toEqual([]);
    const idsA = new Set((await search(a.tenantId, 'fixture')).map((r) => r.id));
    const idsB = new Set((await search(b.tenantId, 'fixture')).map((r) => r.id));
    expect(idsA.size).toBeGreaterThan(0);
    expect([...idsA].some((id) => idsB.has(id))).toBe(false);
    // the application role may call it, PUBLIC may not (the grant matrix lists it)
    const grants = await db.admin.query(
      "SELECT has_function_privilege('app_rw', 'catalog.fn_search_items(text, integer, text, text, real)', 'EXECUTE') AS ok",
    );
    expect(grants.rows[0]!.ok).toBe(true);
  });

  it('the AU GST reference seed from schema_part3 is reproducible per tenant with the shipped constraints', async () => {
    const t = a.tenantId;
    const classes = await db.admin.query<{ id: string; code: string }>(
      'SELECT id, code FROM catalog.tax_classes WHERE tenant_id = $1',
      [t],
    );
    expect(classes.rows.map((c) => c.code)).toEqual(['standard']);
    // composite tenant FK: a rule cannot reference another tenant's class
    const foreign = await db.admin.query<{ id: string }>(
      'SELECT id FROM catalog.tax_classes WHERE tenant_id = $1',
      [b.tenantId],
    );
    await expect(
      db.admin.query(
        `INSERT INTO pricing.tax_rules (tenant_id, name, jurisdiction_country, tax_class_id, kind, rate, valid_from)
         VALUES ($1, 'bad', 'AU', $2, 'vat_gst', 0.1, DATE '2026-01-01')`,
        [t, foreign.rows[0]!.id],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});
