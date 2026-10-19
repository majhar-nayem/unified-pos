import { randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createTenantFixture, startPostgresWithSchema, type TestPostgres } from '@pos/testing';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp, userPrincipal } from '../testing/test-app.js';

const VARIANTS = Number(process.env.BENCH_VARIANTS ?? 100_000);
const LOOKUPS = 400;
const SEARCHES = 200;

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}
function summarise(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    samples: sorted.length,
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    p99Ms: round(percentile(sorted, 99)),
    maxMs: round(sorted[sorted.length - 1]!),
  };
}
/** One edit a person might make: drop, swap or double a letter inside a word of length ≥ 5. */
function misspell(name: string): string {
  const words = name.split(' ');
  const candidates = words
    .map((w, i) => [w, i] as const)
    .filter(([w]) => w.length >= 5 && /^[a-z]+$/.test(w));
  const [word, index] = candidates[randomInt(candidates.length)]!;
  const at = 1 + randomInt(word.length - 2);
  const variants = [
    word.slice(0, at) + word.slice(at + 1),
    word.slice(0, at) + word[at + 1] + word[at] + word.slice(at + 2),
    word.slice(0, at) + word[at] + word.slice(at),
  ];
  words[index] = variants[randomInt(variants.length)]!;
  return words.join(' ');
}

/**
 * Search benchmark (docs/03 §5 F2; informational, not a gate): seeds VARIANTS variants (BENCH_VARIANTS, default
 * 100 000), then measures barcode lookup and fuzzy search through the real HTTP stack and reports p50/p95/p99.
 * Set BENCH_OUT=<file> to also write the numbers as JSON.
 */
describe('catalog search benchmark', () => {
  let db: TestPostgres;
  let t: TestApp;
  let token: string;
  let tenantId: string;

  beforeAll(async () => {
    db = await startPostgresWithSchema();
    t = await createTestApp({ databaseUrl: db.appUrl });
    tenantId = (await createTenantFixture(db.admin, 'bench')).tenantId;
    token = t.auth.register('bench', userPrincipal(tenantId, { kind: 'tenant', id: tenantId }));
  }, 300_000);

  afterAll(async () => {
    await t?.close();
    await db?.stop();
  });

  it(`seeds ${VARIANTS.toLocaleString('en-AU')} variants and reports barcode-lookup and fuzzy-search latency`, async () => {
    const admin = db.admin;
    const seedStart = performance.now();
    // Bulk load without per-row triggers; the search vectors are computed once, set-based, with the same function the triggers use.
    await admin.query('ALTER TABLE catalog.items DISABLE TRIGGER trg_items_search_vector');
    await admin.query(
      'ALTER TABLE catalog.item_variants DISABLE TRIGGER trg_item_variants_search_vector',
    );
    await admin.query('ALTER TABLE catalog.barcodes DISABLE TRIGGER trg_barcodes_search_vector');
    await admin.query(
      `WITH words AS (
         SELECT ARRAY['cotton','leather','organic','premium','classic','vintage','crystal','bamboo','stainless','ceramic','handmade','compact','deluxe','portable','waterproof','electric'] AS adj,
                ARRAY['jacket','sandwich','notebook','headphones','blender','backpack','umbrella','sunglasses','toothbrush','chocolate','keyboard','candle','bottle','sneakers','wallet','speaker'] AS noun),
       gen AS (SELECT g, gen_random_uuid() AS item_id FROM generate_series(1, $2::int) g),
       ins_items AS (
         INSERT INTO catalog.items (id, tenant_id, kind, name, brand_name)
         SELECT gen.item_id, $1, 'product',
                words.adj[1 + gen.g % 16] || ' ' || words.noun[1 + (gen.g / 16) % 16] || ' ' || gen.g,
                'Brand' || (gen.g % 200)
         FROM gen, words RETURNING id),
       ins_variants AS (
         INSERT INTO catalog.item_variants (id, tenant_id, item_id, sku, is_default, default_price_minor)
         SELECT gen_random_uuid(), $1, gen.item_id, 'BENCH-' || gen.g, true, 500 + gen.g % 5000 FROM gen RETURNING id, item_id, sku)
       INSERT INTO catalog.barcodes (id, tenant_id, variant_id, code, kind, is_primary)
       SELECT gen_random_uuid(), $1, v.id, '93' || lpad(substr(v.sku, 7), 11, '0'), 'ean13', true FROM ins_variants v`,
      [tenantId, VARIANTS],
    );
    await admin.query(
      `UPDATE catalog.items i SET search_vector = catalog.fn_item_search_vector(i.tenant_id, i.id, i.name, i.short_name, i.brand_name, i.description)
       WHERE i.tenant_id = $1`,
      [tenantId],
    );
    await admin.query('ALTER TABLE catalog.items ENABLE TRIGGER trg_items_search_vector');
    await admin.query(
      'ALTER TABLE catalog.item_variants ENABLE TRIGGER trg_item_variants_search_vector',
    );
    await admin.query('ALTER TABLE catalog.barcodes ENABLE TRIGGER trg_barcodes_search_vector');
    await admin.query('ANALYZE catalog.items');
    await admin.query('ANALYZE catalog.item_variants');
    await admin.query('ANALYZE catalog.barcodes');
    const seedMs = performance.now() - seedStart;
    const counts = (
      await admin.query<{ items: number; variants: number; barcodes: number }>(
        `SELECT (SELECT count(*) FROM catalog.items WHERE tenant_id = $1)::int AS items,
              (SELECT count(*) FROM catalog.item_variants WHERE tenant_id = $1)::int AS variants,
              (SELECT count(*) FROM catalog.barcodes WHERE tenant_id = $1)::int AS barcodes`,
        [tenantId],
      )
    ).rows[0]!;
    expect(counts).toEqual({ items: VARIANTS, variants: VARIANTS, barcodes: VARIANTS });

    // the lookup must be an index scan on (tenant_id, code), whatever the table size
    const plan = (
      await admin.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT * FROM catalog.barcodes WHERE tenant_id = $1 AND code = '9300000000042'`,
        [tenantId],
      )
    ).rows
      .map((r) => r['QUERY PLAN'])
      .join('\n');
    expect(plan).toMatch(/Index Scan using barcodes_tenant_id_code_key/);

    const api = () => supertest(t.server);
    const auth = { Authorization: `Bearer ${token}` };

    // plan of the fuzzy query (shape of what ItemsService.search runs), printed for tuning
    const client = await db.app.connect(); // the application role: row level security applies to the plan
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await client.query('SET LOCAL pg_trgm.word_similarity_threshold = 0.5');
      const explain = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS) WITH q AS (SELECT plainto_tsquery('simple', 'leather jakcet 4521') AS tsq, 'leather jakcet 4521'::text AS needle)
         SELECT i.id, COALESCE(ts_rank_cd(i.search_vector, q.tsq), 0) AS r, word_similarity(q.needle, lower(i.name)) AS s
         FROM catalog.items i, q WHERE i.tenant_id = $1 AND (i.search_vector @@ q.tsq OR q.needle <% lower(i.name))
         ORDER BY GREATEST(LEAST(COALESCE(ts_rank_cd(i.search_vector, q.tsq), 0), 1), word_similarity(q.needle, lower(i.name))) DESC LIMIT 3`,
        [tenantId],
      );
      console.log(`[bench-plan]\n${explain.rows.map((r) => r['QUERY PLAN']).join('\n')}`);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    // --- warm up the pool, JIT and caches
    for (let i = 0; i < 20; i += 1)
      await api()
        .get('/v1/variants/by-barcode')
        .set(auth)
        .query({ code: `93${String(1 + i).padStart(11, '0')}` })
        .expect(200);
    for (let i = 0; i < 10; i += 1)
      await api().get('/v1/items/search').set(auth).query({ q: 'leather jacket' }).expect(200);

    // --- barcode lookup (scan path), HTTP end to end
    const lookup: number[] = [];
    for (let i = 0; i < LOOKUPS; i += 1) {
      const n = 1 + randomInt(VARIANTS);
      const started = performance.now();
      const res = await api()
        .get('/v1/variants/by-barcode')
        .set(auth)
        .query({ code: `93${String(n).padStart(11, '0')}` });
      lookup.push(performance.now() - started);
      expect(res.status).toBe(200);
      expect(res.body.variant.sku).toBe(`BENCH-${n}`);
    }

    // --- fuzzy search with misspellings; also measures how often the intended item is in the top 3
    const search: number[] = [];
    let top3 = 0;
    let top1 = 0;
    for (let i = 0; i < SEARCHES; i += 1) {
      const n = 1 + randomInt(VARIANTS);
      const name = (
        await admin.query<{ name: string }>(
          `SELECT name FROM catalog.items WHERE tenant_id = $1 AND id = (SELECT item_id FROM catalog.item_variants WHERE tenant_id = $1 AND sku = $2)`,
          [tenantId, `BENCH-${n}`],
        )
      ).rows[0]!.name;
      const query = misspell(name);
      const started = performance.now();
      const res = await api().get('/v1/items/search').set(auth).query({ q: query, limit: 3 });
      search.push(performance.now() - started);
      expect(res.status).toBe(200);
      const names = res.body.hits.map((h: { item: { name: string } }) => h.item.name);
      if (names.includes(name)) top3 += 1;
      if (names[0] === name) top1 += 1;
    }

    const report = {
      generatedAt: new Date().toISOString(),
      variants: VARIANTS,
      seedSeconds: Math.round(seedMs / 100) / 10,
      barcodeLookup: summarise(lookup),
      fuzzySearch: {
        ...summarise(search),
        top3HitRate: top3 / SEARCHES,
        top1HitRate: top1 / SEARCHES,
      },
      note: 'Informational. Includes supertest HTTP and the full guard/interceptor pipeline; single connection, postgres:16 Testcontainer on a developer machine.',
    };
    console.log(`[bench] ${JSON.stringify(report)}`);
    if (process.env.BENCH_OUT) {
      mkdirSync(dirname(process.env.BENCH_OUT), { recursive: true });
      writeFileSync(process.env.BENCH_OUT, JSON.stringify(report, null, 2));
    }
    // Quality (not latency) is asserted: a misspelled name must still surface the item.
    expect(top3 / SEARCHES).toBeGreaterThan(0.7);
    void randomUUID;
  }, 900_000);
});
