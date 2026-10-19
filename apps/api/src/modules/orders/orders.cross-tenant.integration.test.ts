import { PERMISSION_KEYS } from '@pos/auth';
import { checkSchemaMirror, formatSchemaDrift, mirroredTables } from '@pos/db';
import {
  type FixtureRegistry,
  checkContractCompleteness,
  formatHarnessReport,
  listOperations,
  runCrossTenantHarness,
} from '@pos/testing';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedOrderFixtures } from './testing/helpers.js';
import { buildOrdersWorld, type OrdersWorld } from './testing/orders-world.js';

/**
 * docs/03 §9 cross-tenant harness restricted to the orders and receipts operations (the shared
 * apps/api cross-tenant test owns the whole document; it needs the fixture names below added to its
 * registry once the integration lead wires this module in: see docs/releases/s-f4.md).
 */
describe('orders and receipts: cross-tenant harness, contract completeness, schema mirror', () => {
  let w: OrdersWorld;
  let fixtures: FixtureRegistry;
  let doc: { paths: Record<string, Record<string, { operationId?: string }>> };

  beforeAll(async () => {
    w = await buildOrdersWorld();
    fixtures = {
      tenantId: w.tenantId,
      locationId: w.locationA,
      ...(await seedOrderFixtures({
        server: w.t.server,
        token: w.ownerToken,
        locationId: w.locationA,
      })),
    };
    const res = await supertest(w.t.server).get('/v1/openapi.json').expect(200);
    const all = res.body as typeof doc;
    // only this stream's operations
    doc = {
      ...all,
      paths: Object.fromEntries(
        Object.entries(all.paths)
          .map(
            ([path, verbs]) =>
              [
                path,
                Object.fromEntries(
                  Object.entries(verbs).filter(([, op]) => op.operationId?.startsWith('orders.')),
                ),
              ] as const,
          )
          .filter(([, verbs]) => Object.keys(verbs).length > 0),
      ),
    };
  }, 240_000);
  afterAll(async () => {
    await w?.close();
  });

  it('every orders and receipts operation answers 404 to a foreign tenant and to an out-of-scope principal', async () => {
    const operations = listOperations(doc);
    expect(operations).toHaveLength(24); // 20 orders operations + 4 receipts operations
    expect(checkContractCompleteness(operations, fixtures)).toEqual([]);
    const scopedToA = w.principal('orders-scoped-a', { kind: 'location', id: w.locationA });
    const report = await runCrossTenantHarness({
      doc,
      foreignFixtures: fixtures,
      outOfScopeFixtures: { ...fixtures, locationId: w.locationB },
      tokens: { foreignTenant: w.foreign.token, locationScoped: scopedToA },
      invoke: async ({ method, url, headers, body }) => {
        let req = supertest(w.t.server)[method](url);
        for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
        const res = body === undefined ? await req : await req.send(body as object);
        return { status: res.status, body: res.body };
      },
    });
    expect(report.failures, formatHarnessReport(report)).toEqual([]);
    expect(report.cases).toHaveLength(operations.length * 2);
    expect(report.skipped).toEqual([]);
  }, 180_000);

  it('every operation names a permission from the catalogue, is scoped, and mutating POSTs demand an Idempotency-Key', () => {
    const operations = listOperations(doc);
    for (const op of operations) {
      expect(op.permission, op.operationId).toBeDefined();
      expect(PERMISSION_KEYS, op.operationId).toContain(op.permission);
      expect(op.scope, op.operationId).toBeDefined();
      if (op.method === 'post') expect(op.idempotent, op.operationId).toBe(true);
      if (op.method === 'delete' || op.method === 'patch')
        expect(op.concurrency, op.operationId).toBe('if-match');
    }
    // the plan's F4 surface is all there
    const ids = operations.map((o) => o.operationId);
    for (const required of [
      'orders.order.create',
      'orders.line.add',
      'orders.line.update',
      'orders.line.remove',
      'orders.discount.apply',
      'orders.order.suspend',
      'orders.order.resume',
      'orders.order.place',
      'orders.order.void',
      'orders.check.split',
      'orders.check.merge',
      'orders.order.return',
      'orders.receipt.create',
      'orders.receipt.render',
    ])
      expect(ids).toContain(required);
  });

  it('the Drizzle mirror of every orders.* table matches the migrated schema column for column', async () => {
    const drift = (await checkSchemaMirror(w.db.admin)).filter((d) =>
      d.table.startsWith('orders.'),
    );
    expect(formatSchemaDrift(drift)).toBe('');
    expect(drift).toEqual([]);
    const mirrored = mirroredTables()
      .filter((t) => t.schema === 'orders')
      .map((t) => t.name)
      .sort();
    expect(mirrored).toEqual([
      'checks',
      'order_charges',
      'order_discounts',
      'order_events',
      'order_line_modifiers',
      'order_line_taxes',
      'order_lines',
      'order_number_sequences',
      'orders',
      'receipts',
      'return_authorizations',
    ]);
  });
});
