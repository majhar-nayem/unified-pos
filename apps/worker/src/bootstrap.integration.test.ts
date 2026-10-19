import { runInTenantTransaction } from '@pos/db';
import {
  createTenantFixture,
  startPostgresWithSchema,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '@pos/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startWorker, verifyConnections, type RunningWorker } from './bootstrap.js';
import { EVENTS_STREAM } from './modules/outbox/public/index.js';
import { until } from './test-support.js';

describe('worker bootstrap', () => {
  let db: TestPostgres;
  let redisBox: TestRedis;
  let probe: Redis;
  let worker: RunningWorker;
  let tenantId: string;

  beforeAll(async () => {
    [db, redisBox] = await Promise.all([startPostgresWithSchema(), startRedis()]);
    process.env.DATABASE_URL = db.appUrl;
    process.env.REDIS_URL = redisBox.url;
    tenantId = (await createTenantFixture(db.admin, 'bootstrap')).tenantId;
    probe = new Redis(redisBox.url);
    worker = await startWorker();
  });

  afterAll(async () => {
    await worker?.stop();
    probe?.disconnect();
    await db?.stop();
    await redisBox?.stop();
  });

  it('starts relay, consumer group and job runner with telemetry off (no collector configured)', () => {
    expect(worker.telemetry.enabled).toBe(false);
    expect(worker.consumers.map((c) => c.name)).toEqual(['event-log']);
    expect(worker.jobs.registered).toEqual(['idempotency.purge']);
  });

  it('relays a committed event to the stream and the consumer processes it exactly once', async () => {
    await runInTenantTransaction(db.app, tenantId, async (uow) => {
      uow.emit({
        type: 'location.created',
        aggregateKind: 'test',
        aggregateId: tenantId,
        payload: { n: 1 },
      });
    });
    await until(async () => (await probe.xlen(EVENTS_STREAM)) === 1, 'the event on the stream');
    await until(async () => {
      const r = await db.admin.query(
        "SELECT count(*)::int AS n FROM audit.processed_events WHERE consumer = 'event-log'",
      );
      return r.rows[0].n === 1;
    }, 'the consumer to record the event');
    const left = await db.admin.query(
      'SELECT count(*)::int AS n FROM audit.outbox_events WHERE published_at IS NULL',
    );
    expect(left.rows[0].n).toBe(0);
  });

  it('has the hourly purge scheduled on the BullMQ queue', async () => {
    expect((await worker.jobs.counts()).delayed).toBe(1);
  });

  it('verifyConnections fails fast when Postgres or Redis cannot answer', async () => {
    const dead = new Redis('redis://127.0.0.1:1', {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    await expect(verifyConnections(db.app, dead)).rejects.toThrow();
    dead.disconnect();
  });

  it('stops cleanly and a second stop is a no-op', async () => {
    await worker.stop();
    await expect(worker.stop()).resolves.toBeUndefined();
  });
});
