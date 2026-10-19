import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

import {
  DEAD_STREAM,
  EVENTS_STREAM,
  EventLogConsumer,
  OutboxRelayService,
  RedisStreamPublisher,
  type EventPublisher,
} from '../modules/outbox/public/index.js';

import { OutboxStats, streamLag } from './outbox-stats.js';

const STATS_SQL = fileURLToPath(new URL('../../../../infra/sql/outbox-stats.sql', import.meta.url));

describe('outbox gauges', () => {
  let db: TestPostgres;
  let redisBox: TestRedis;
  let redis: Redis;
  let tenantId: string;

  beforeAll(async () => {
    [db, redisBox] = await Promise.all([startPostgresWithSchema(), startRedis()]);
    redis = new Redis(redisBox.url);
    tenantId = (await createTenantFixture(db.admin, 'stats')).tenantId;
  });

  afterAll(async () => {
    redis?.disconnect();
    await db?.stop();
    await redisBox?.stop();
  });

  const emit = (type: string) =>
    runInTenantTransaction(db.app, tenantId, async (uow) => {
      uow.emit({ type, aggregateKind: 'test', aggregateId: tenantId, payload: {} });
    });

  const failing: EventPublisher = {
    publish: async () => {
      throw new Error('broker down');
    },
    publishDead: async () => undefined,
  };

  it('falls back to relay-observed lower bounds while audit.fn_outbox_stats() is not installed', async () => {
    await emit('config.changed');
    await emit('config.changed');
    const relay = new OutboxRelayService(db.app, failing, { batchSize: 10 });
    const stats = new OutboxStats(db.app, () => relay.lastObservation);

    expect(await stats.read()).toMatchObject({ backlog: 0, oldestAgeSeconds: 0, source: 'relay' });
    await relay.relayOnce(); // both publishes fail, both rows stay pending
    const reading = await stats.read();
    expect(reading.source).toBe('relay');
    expect(reading.backlog).toBe(2);
    expect(reading.oldestAgeSeconds).toBeGreaterThanOrEqual(0);

    // the application role cannot count across tenants: this is why the function is needed
    const direct = await db.app.query(
      'SELECT count(*)::int AS n FROM audit.outbox_events WHERE published_at IS NULL',
    );
    expect(direct.rows[0].n).toBe(0);
  });

  it('reports exact totals once the proposed function is installed', async () => {
    await db.admin.query(readFileSync(STATS_SQL, 'utf8'));
    await db.admin.query('GRANT EXECUTE ON FUNCTION audit.fn_outbox_stats() TO app_rw');

    const relay = new OutboxRelayService(db.app, failing, { batchSize: 10 });
    const stats = new OutboxStats(db.app, () => relay.lastObservation);
    const reading = await stats.read();
    expect(reading.source).toBe('db');
    expect(reading.backlog).toBe(2);
    expect(reading.oldestAgeSeconds).toBeGreaterThan(0);

    const working = new OutboxRelayService(db.app, new RedisStreamPublisher(redis), {
      batchSize: 10,
    });
    await working.relayOnce();
    expect(await stats.read()).toMatchObject({ backlog: 0, oldestAgeSeconds: 0, source: 'db' });
  });

  it('reports the relay pass through the onPass hook', async () => {
    await emit('config.changed');
    const passes: Array<{ claimed: number; published: number; failed: number }> = [];
    const relay = new OutboxRelayService(db.app, new RedisStreamPublisher(redis), {
      onPass: (info) => void passes.push(info),
    });
    await relay.relayOnce();
    expect(passes).toEqual([
      expect.objectContaining({ claimed: 1, published: 1, failed: 0, dead: 0 }),
    ]);
  });

  it('reports pending entries and lag per consumer group and the dead-letter length', async () => {
    const consumer = new EventLogConsumer(redis, db.app);
    await consumer.ensureGroup();
    const before = await streamLag(redis);
    expect(before[`${EVENTS_STREAM}:event-log:lag`]).toBeGreaterThan(0);
    expect(before[DEAD_STREAM]).toBe(0);

    await consumer.readOnce();
    const after = await streamLag(redis);
    expect(after[`${EVENTS_STREAM}:event-log:lag`]).toBe(0);
    expect(after[`${EVENTS_STREAM}:event-log:pending`]).toBe(0);
  });

  it('streamLag works before the stream exists', async () => {
    const empty = new Redis(redisBox.url, { db: 3 });
    expect(await streamLag(empty)).toEqual({ [DEAD_STREAM]: 0 });
    empty.disconnect();
  });
});
