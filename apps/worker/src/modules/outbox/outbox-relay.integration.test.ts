import { type OutboxEventRow, runInTenantTransaction } from '@pos/db';
import {
  createTenantFixture,
  startPostgresWithSchema,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '@pos/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EventLogConsumer } from './event-consumer.js';
import { OutboxRelayService } from './outbox-relay.service.js';
import {
  DEAD_STREAM,
  EVENTS_STREAM,
  type EventPublisher,
  RedisStreamPublisher,
} from './publisher.js';

describe('outbox relay + consumer', () => {
  let db: TestPostgres;
  let redisBox: TestRedis;
  let redis: Redis;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    [db, redisBox] = await Promise.all([startPostgresWithSchema(), startRedis()]);
    redis = new Redis(redisBox.url);
    tenantA = (await createTenantFixture(db.admin, 'relay-a')).tenantId;
    tenantB = (await createTenantFixture(db.admin, 'relay-b')).tenantId;
  });

  afterAll(async () => {
    redis?.disconnect();
    await db?.stop();
    await redisBox?.stop();
  });

  async function emit(tenantId: string, type: string): Promise<void> {
    await runInTenantTransaction(db.app, tenantId, async (uow) => {
      uow.emit({ type, aggregateKind: 'test', aggregateId: tenantId, payload: { hello: 'world' } });
    });
  }

  it('publishes unpublished events for two tenants to the stream and marks published_at', async () => {
    await emit(tenantA, 'location.created');
    await emit(tenantB, 'location.created');
    const relay = new OutboxRelayService(db.app, new RedisStreamPublisher(redis), {
      idleDelayMs: 10,
    });
    expect(await relay.relayOnce()).toBe(2);
    expect(await relay.relayOnce()).toBe(0);
    expect(await redis.xlen(EVENTS_STREAM)).toBe(2);
    const left = await db.admin.query(
      'SELECT count(*)::int AS n FROM audit.outbox_events WHERE published_at IS NULL',
    );
    expect(left.rows[0].n).toBe(0);
  });

  it('a consumer processes each event once, even when the stream redelivers', async () => {
    const consumer = new EventLogConsumer(redis, db.app);
    await consumer.ensureGroup();
    expect(await consumer.readOnce()).toBe(2);
    expect(consumer.seen.map((e) => e.tenantId).sort()).toEqual([tenantA, tenantB].sort());
    // simulate redelivery: a second consumer instance with the same group name gets the same ids via XCLAIM-like replay
    const entries = (await redis.xrange(EVENTS_STREAM, '-', '+')) as Array<[string, string[]]>;
    for (const [, fields] of entries) await redis.xadd(EVENTS_STREAM, '*', ...fields); // same event ids, new stream ids
    expect(await consumer.readOnce()).toBe(0);
    expect(consumer.seen).toHaveLength(2);
    const processed = await db.admin.query(
      "SELECT count(*)::int AS n FROM audit.processed_events WHERE consumer = 'event-log'",
    );
    expect(processed.rows[0].n).toBe(2);
  });

  it('moves an event to the dead stream after the attempts are exhausted', async () => {
    await emit(tenantA, 'config.changed');
    const failing: EventPublisher = {
      publish: async () => {
        throw new Error('broker down');
      },
      publishDead: async (event: OutboxEventRow, reason: string) => {
        await redis.xadd(DEAD_STREAM, '*', 'id', event.id, 'reason', reason);
      },
    };
    const relay = new OutboxRelayService(db.app, failing, { maxAttempts: 3 });
    // each pass claims the row again after its lease is cleared by markOutboxFailed
    expect(await relay.relayOnce()).toBe(1);
    expect(await relay.relayOnce()).toBe(1);
    expect(await relay.relayOnce()).toBe(1);
    expect(await relay.relayOnce()).toBe(1); // attempts = 4 > 3 → dead
    expect(await relay.relayOnce()).toBe(0);
    expect(await redis.xlen(DEAD_STREAM)).toBe(1);
    const row = await db.admin.query<{
      published_at: Date | null;
      attempts: number;
      last_error: string;
    }>(
      "SELECT published_at, attempts, last_error FROM audit.outbox_events WHERE tenant_id = $1 AND event_type = 'config.changed'",
      [tenantA],
    );
    expect(row.rows[0]!.published_at).not.toBeNull();
    expect(row.rows[0]!.attempts).toBe(4);
    expect(row.rows[0]!.last_error).toBe('broker down');
  });
});
