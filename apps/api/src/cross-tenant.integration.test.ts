import {
  type FixtureRegistry,
  checkContractCompleteness,
  createCatalogFixture,
  createHierarchyFixture,
  createIdentityFixture,
  formatHarnessReport,
  listOperations,
  runCrossTenantHarness,
  startPostgresWithSchema,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '@pos/testing';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedOrderFixtures } from './modules/orders/public/testing.js';
import { createPricingFixture } from './modules/promotions/public/index.js';
import { createTestApp, stubFirstAdmin, type TestApp, userPrincipal } from './testing/test-app.js';

/**
 * docs/03-implementation-plan.md §9 cross-tenant harness: generated from /v1/openapi.json, so every
 * new route is covered automatically. Scenario (a) foreign-tenant token, (b) same-tenant principal
 * scoped to one location hitting the sibling location/register. Both must 404.
 */
describe('cross-tenant harness', () => {
  let db: TestPostgres;
  let redis: TestRedis;
  let t: TestApp;

  beforeAll(async () => {
    [db, redis] = await Promise.all([startPostgresWithSchema(), startRedis()]);
    t = await createTestApp({
      databaseUrl: db.appUrl,
      redisUrl: redis.url,
      firstAdmin: stubFirstAdmin,
    });
  });

  afterAll(async () => {
    await t?.close();
    await db?.stop();
    await redis?.stop();
  });

  it('every non-public endpoint answers 404 to a foreign tenant and to an out-of-scope principal', async () => {
    const a = await createHierarchyFixture(db.admin, 'harness-a');
    const b = await createHierarchyFixture(db.admin, 'harness-b');
    const ia = await createIdentityFixture(db.admin, a);
    // Wave 1 checkpoint: fixtures for the routes added by S-F2 (catalog, tax), S-F3 (pricing) and
    // S-F4 (orders, receipts). Payments routes reuse the order/check fixtures. Each stream also
    // runs the harness over its own operations in its own test; this file proves completeness.
    const catalog = await createCatalogFixture(db.admin, a);
    const pricing = await createPricingFixture(db.admin, a);
    const ownerA = t.auth.register(
      'owner-a',
      userPrincipal(a.tenantId, { kind: 'tenant', id: a.tenantId }),
    );
    const orders = await seedOrderFixtures({
      server: t.server,
      token: ownerA,
      locationId: a.locationId,
    });
    const foreignTenant = t.auth.register(
      'owner-b',
      userPrincipal(b.tenantId, { kind: 'tenant', id: b.tenantId }),
    );
    const locationScoped = t.auth.register(
      'mgr-a',
      userPrincipal(a.tenantId, { kind: 'location', id: a.locationId }),
    );

    const fixturesA: FixtureRegistry = {
      tenantId: a.tenantId,
      rootOrgUnitId: a.rootOrgUnitId,
      childOrgUnitId: a.childOrgUnitId,
      legalEntityId: a.legalEntityId,
      locationId: a.locationId,
      otherLocationId: a.otherLocationId,
      departmentId: a.departmentId,
      registerId: a.registerId,
      otherRegisterId: a.otherRegisterId,
      ...ia,
      ...catalog,
      ...pricing,
      ...orders,
    };
    // What a principal scoped to location A must not reach: the sibling location and its register.
    const outOfScope: FixtureRegistry = {
      ...fixturesA,
      locationId: a.otherLocationId,
      registerId: a.otherRegisterId,
    };

    const doc = (await supertest(t.server).get('/v1/openapi.json').expect(200)).body;
    const operations = listOperations(doc);
    expect(operations.length).toBeGreaterThan(10);
    expect(checkContractCompleteness(operations, fixturesA)).toEqual([]);

    const report = await runCrossTenantHarness({
      doc,
      foreignFixtures: fixturesA,
      outOfScopeFixtures: outOfScope,
      tokens: { foreignTenant, locationScoped },
      invoke: async ({ method, url, headers, body }) => {
        let req = supertest(t.server)[method](url);
        for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
        const res = body === undefined ? await req : await req.send(body as object);
        return { status: res.status, body: res.body };
      },
    });
    expect(report.failures, formatHarnessReport(report)).toEqual([]);
    expect(report.cases.length).toBe((operations.length - report.skipped.length) * 2);
    // Nothing is skipped silently: only public and operator routes.
    expect(report.skipped.every((s) => /\((public|operator-only)\)$/.test(s))).toBe(true);
  }, 120_000);
});
