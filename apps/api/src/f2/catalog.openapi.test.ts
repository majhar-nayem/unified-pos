import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app.module.js';
import {
  API_PREFIX,
  type OpenApiDocument,
  type OpenApiOperation,
  RATE_LIMIT_CONFIG,
  RATE_LIMIT_DISABLED,
} from '../modules/kernel/public/index.js';

const committed = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../packages/contracts/openapi/v1.json',
    ),
    'utf8',
  ),
) as OpenApiDocument;

const f2 = (doc: OpenApiDocument): Record<string, OpenApiOperation> =>
  Object.fromEntries(
    Object.entries(doc.paths).flatMap(([path, ops]) =>
      Object.entries(ops)
        .filter(([, op]) => /^(catalog\.|pricing\.tax)/.test(op.operationId))
        .map(([verb, op]) => [`${verb.toUpperCase()} ${path}`, op] as const),
    ),
  );

/** Updates of aggregates that carry a version column. */
const VERSIONED_UPDATES = new Set([
  'catalog.item.update',
  'catalog.variant.update',
  'catalog.category.update',
  'catalog.tax_class.update',
  'catalog.supplier.update',
  'catalog.menu.update',
  'catalog.modifier_group.update',
  'pricing.tax_rule.update',
]);

/** The committed packages/contracts/openapi/v1.json must contain the F2 operations exactly as the API generates them. */
describe('F2 OpenAPI operations', () => {
  let app: INestApplication;
  let live: OpenApiDocument;

  beforeAll(async () => {
    process.env.SKIP_ACCESS_SEED = '1';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RATE_LIMIT_CONFIG)
      .useValue(RATE_LIMIT_DISABLED)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix(API_PREFIX);
    await app.init();
    live = (await supertest(app.getHttpServer()).get('/v1/openapi.json').expect(200))
      .body as OpenApiDocument;
  });

  afterAll(async () => {
    delete process.env.SKIP_ACCESS_SEED;
    await app?.close();
  });

  it('the committed document matches the generated one for every catalog and pricing operation (run `pnpm --filter @pos/api build && pnpm --filter @pos/api openapi:export` after changing a route)', () => {
    const generated = f2(live);
    expect(Object.keys(generated).length).toBeGreaterThanOrEqual(75);
    expect(f2(committed)).toEqual(generated);
  });

  it('every F2 operation is permissioned, scoped, and documents its concurrency and idempotency', () => {
    for (const [name, op] of Object.entries(f2(live))) {
      expect(op['x-permission'], name).toBeTruthy();
      expect(op['x-scope'], name).toBeDefined();
      if (VERSIONED_UPDATES.has(op.operationId)) expect(op['x-concurrency'], name).toBe('if-match');
      if (name.startsWith('POST') && !op.operationId.endsWith('.resolve'))
        expect(op['x-idempotent'], name).toBe(true);
    }
    const resolve = f2(live)['GET /v1/menus/resolve']!;
    expect(resolve['x-scope']).toMatchObject({
      kind: 'dynamic',
      scopeKind: 'location',
      idField: 'locationId',
    });
  });
});
