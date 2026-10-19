import {
  createHierarchyFixture,
  startPostgresWithSchema,
  startRedis,
  type HierarchyFixture,
  type TestPostgres,
  type TestRedis,
} from '@pos/testing';
import { Redis } from 'ioredis';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RateLimitConfig } from './modules/kernel/public/index.js';
import { createTestApp, stubFirstAdmin, type TestApp, userPrincipal } from './testing/test-app.js';

const LIMITS: RateLimitConfig = {
  enabled: true,
  principal: { capacity: 5, refillPerSecond: 1 },
  anonymous: { capacity: 3, refillPerSecond: 1 },
  keyPrefix: 'rl-test',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('rate limiting (pipeline step 1)', () => {
  let db: TestPostgres;
  let redis: TestRedis;
  let t: TestApp;
  let fx: HierarchyFixture;
  let web: string;
  let pos: string;
  const api = () => supertest(t.server);

  beforeAll(async () => {
    [db, redis] = await Promise.all([startPostgresWithSchema(), startRedis()]);
    t = await createTestApp({
      databaseUrl: db.appUrl,
      redisUrl: redis.url,
      firstAdmin: stubFirstAdmin,
      rateLimit: LIMITS,
    });
    fx = await createHierarchyFixture(db.admin, 'acme');
    const principal = userPrincipal(fx.tenantId, { kind: 'tenant', id: fx.tenantId });
    web = t.auth.register('web', principal);
    pos = t.auth.register('pos', { ...principal, tokenKind: 'pos' });
  });

  afterAll(async () => {
    await t?.close();
    await db?.stop();
    await redis?.stop();
  });

  it('an authenticated principal gets `capacity` requests, then 429 with Retry-After, then refills', async () => {
    for (let i = 0; i < LIMITS.principal.capacity; i++) {
      const res = await api()
        .get('/v1/tenants/me')
        .set('Authorization', `Bearer ${web}`)
        .expect(200);
      expect(res.headers['x-ratelimit-limit']).toBe('5');
      expect(res.headers['x-ratelimit-remaining']).toBe(String(4 - i));
    }
    const refused = await api()
      .get('/v1/tenants/me')
      .set('Authorization', `Bearer ${web}`)
      .expect(429);
    expect(refused.headers['retry-after']).toBe('1');
    expect(refused.headers['x-ratelimit-remaining']).toBe('0');
    expect(refused.body.error).toMatchObject({
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: 1 },
    });
    // the same user on a POS token shares the bucket (keyed by tenant + principal, not by token)
    await api().get('/v1/tenants/me').set('Authorization', `Bearer ${pos}`).expect(429);
    await sleep(1_100);
    await api().get('/v1/tenants/me').set('Authorization', `Bearer ${web}`).expect(200);
    await api().get('/v1/tenants/me').set('Authorization', `Bearer ${web}`).expect(429);
  });

  it('anonymous and badly authenticated requests share one bucket per IP', async () => {
    await api().get('/v1/openapi.json').expect(200);
    await api().get('/v1/openapi.json').expect(200);
    await api().get('/v1/tenants/me').set('Authorization', 'Bearer test:nobody').expect(401);
    const refused = await api().get('/v1/openapi.json').expect(429);
    expect(refused.headers['retry-after']).toBe('1');
    // a different principal is unaffected
    const other = t.auth.register(
      'other',
      userPrincipal(fx.tenantId, { kind: 'tenant', id: fx.tenantId }),
    );
    await api().get('/v1/tenants/me').set('Authorization', `Bearer ${other}`).expect(200);
  });

  it('with Redis unavailable, web tokens fail closed (429) and POS tokens fail open', async () => {
    const dead = new Redis('redis://127.0.0.1:1', {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    dead.on('error', () => undefined);
    const offline = await createTestApp({
      databaseUrl: db.appUrl,
      redisClient: dead,
      firstAdmin: stubFirstAdmin,
      rateLimit: LIMITS,
    });
    try {
      const principal = userPrincipal(fx.tenantId, { kind: 'tenant', id: fx.tenantId });
      const webToken = offline.auth.register('web', principal);
      const posToken = offline.auth.register('pos', { ...principal, tokenKind: 'pos' });
      const deviceToken = offline.auth.register('device', {
        ...principal,
        kind: 'device',
        tokenKind: 'device',
      });
      const closed = await supertest(offline.server)
        .get('/v1/tenants/me')
        .set('Authorization', `Bearer ${webToken}`)
        .expect(429);
      expect(closed.body.error.code).toBe('RATE_LIMITER_UNAVAILABLE');
      expect(closed.headers['retry-after']).toBe('1');
      await supertest(offline.server).get('/v1/openapi.json').expect(429);
      await supertest(offline.server)
        .get('/v1/tenants/me')
        .set('Authorization', `Bearer ${posToken}`)
        .expect(200);
      await supertest(offline.server)
        .get('/v1/tenants/me')
        .set('Authorization', `Bearer ${deviceToken}`)
        .expect(200);
    } finally {
      await offline.close();
    }
  });
});
