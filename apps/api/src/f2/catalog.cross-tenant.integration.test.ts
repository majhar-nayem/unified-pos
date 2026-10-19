import {
  type FixtureRegistry,
  checkContractCompleteness,
  createCatalogFixture,
  createHierarchyFixture,
  formatHarnessReport,
  listOperations,
  runCrossTenantHarness,
  startPostgresWithSchema,
  type TestPostgres,
} from '@pos/testing';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, stubFirstAdmin, type TestApp, userPrincipal } from '../testing/test-app.js';

/**
 * The generated cross-tenant harness (docs/03 §9) restricted to the F2 operations: every catalog and
 * tax route answers 404 to a foreign tenant's token, and location-scoped routes answer 404 to a
 * same-tenant principal scoped to the sibling location. Generated from /v1/openapi.json, so a new
 * catalog route is covered (or fails completeness) without touching this file.
 */
describe('catalog cross-tenant harness', () => {
  let db: TestPostgres;
  let t: TestApp;

  beforeAll(async () => {
    db = await startPostgresWithSchema();
    t = await createTestApp({ databaseUrl: db.appUrl, firstAdmin: stubFirstAdmin });
  });

  afterAll(async () => {
    await t?.close();
    await db?.stop();
  });

  it('every catalog/pricing endpoint is invisible to a foreign tenant and to an out-of-scope location', async () => {
    const a = await createHierarchyFixture(db.admin, 'cat-a');
    const b = await createHierarchyFixture(db.admin, 'cat-b');
    const ca = await createCatalogFixture(db.admin, a);
    await createCatalogFixture(db.admin, b);
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
      locationId: a.locationId,
      otherLocationId: a.otherLocationId,
      registerId: a.registerId,
      otherRegisterId: a.otherRegisterId,
      ...ca,
    };
    const outOfScope: FixtureRegistry = {
      ...fixturesA,
      locationId: a.otherLocationId,
      registerId: a.otherRegisterId,
    };

    const full = (await supertest(t.server).get('/v1/openapi.json').expect(200)).body as {
      paths: Record<string, Record<string, { operationId: string }>>;
    };
    const paths = Object.fromEntries(
      Object.entries(full.paths)
        .map(
          ([path, ops]) =>
            [
              path,
              Object.fromEntries(
                Object.entries(ops).filter(([, op]) =>
                  /^(catalog\.|pricing\.tax)/.test(op.operationId),
                ),
              ),
            ] as const,
        )
        .filter(([, ops]) => Object.keys(ops).length > 0),
    );
    const doc = { openapi: '3.1.0', paths };
    const operations = listOperations(doc);
    expect(operations.length).toBeGreaterThanOrEqual(75);
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
    expect(report.cases.length).toBe(operations.length * 2);
  }, 240_000);
});
