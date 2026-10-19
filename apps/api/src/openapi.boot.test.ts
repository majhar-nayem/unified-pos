import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from './app.module.js';
import {
  API_PREFIX,
  type OpenApiDocument,
  RATE_LIMIT_CONFIG,
  RATE_LIMIT_DISABLED,
} from './modules/kernel/public/index.js';

/** Boots the real AppModule (no database traffic) and checks the generated document. */
describe('OpenAPI document', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.SKIP_ACCESS_SEED = '1'; // no database in this test; the identity seed runs on bootstrap otherwise
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RATE_LIMIT_CONFIG)
      .useValue(RATE_LIMIT_DISABLED) // no Redis here either; the limiter has its own suite
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix(API_PREFIX);
    await app.init();
  });

  afterAll(async () => {
    delete process.env.SKIP_ACCESS_SEED;
    await app?.close();
  });

  it('is OpenAPI 3.1 and every operation is complete', async () => {
    const res = await supertest(app.getHttpServer()).get('/v1/openapi.json').expect(200);
    const doc = res.body as OpenApiDocument;
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths['/v1/health']?.get?.operationId).toBe('platform.health');
    expect(doc.paths['/v1/health']?.get?.['x-public']).toBe(true);
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [verb, op] of Object.entries(ops)) {
        expect(op.operationId, `${verb} ${path}`).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
        const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
        for (const name of pathParams) {
          const param = op.parameters.find((p) => p.name === name && p.in === 'path');
          expect(param, `${verb} ${path} declares ${name}`).toBeDefined();
          expect(param!['x-fixture']).toBeTruthy();
        }
        if (!op['x-public'] && !op['x-operator'] && pathParams.length > 0) {
          expect(op['x-scope'], `${verb} ${path} needs x-scope`).toBeDefined();
        }
        if (op.requestBody) {
          const content = (op.requestBody as { content: Record<string, { example?: unknown }> })
            .content['application/json'];
          expect(content?.example, `${verb} ${path} needs a body example`).toBeDefined();
        }
      }
    }
  });

  it('serves public routes anonymously, echoes correlation ids and shapes unknown routes through the filter', async () => {
    const health = await supertest(app.getHttpServer()).get('/v1/health').expect(200);
    expect(health.body.status).toBe('ok');
    expect(health.headers['x-correlation-id']).toBeTruthy();
    const echoed = await supertest(app.getHttpServer())
      .get('/v1/health')
      .set('X-Correlation-Id', 'trace-abc-123')
      .expect(200);
    expect(echoed.headers['x-correlation-id']).toBe('trace-abc-123');
    const missing = await supertest(app.getHttpServer()).get('/v1/nope').expect(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
    expect(missing.body.error.correlationId).toBeTruthy();
  });
});
