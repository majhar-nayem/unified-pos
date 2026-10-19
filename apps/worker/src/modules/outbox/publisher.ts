import type { Redis } from 'ioredis';
import type { OutboxEventRow } from '@pos/db';

export const EVENTS_STREAM = 'pos:events';
export const DEAD_STREAM = 'pos:events:dead';
export const STREAM_MAXLEN = 1_000_000;

/** Publishes one outbox row to a Redis Stream; swapped for a failing stub in tests. */
export interface EventPublisher {
  publish(event: OutboxEventRow): Promise<void>;
  publishDead(event: OutboxEventRow, reason: string): Promise<void>;
}

export function streamFields(event: OutboxEventRow): string[] {
  return [
    'id',
    event.id,
    'tenant_id',
    event.tenant_id,
    'location_id',
    event.location_id ?? '',
    'type',
    event.event_type,
    'aggregate_kind',
    event.aggregate_kind,
    'aggregate_id',
    event.aggregate_id,
    'aggregate_version',
    event.aggregate_version === null ? '' : String(event.aggregate_version),
    'occurred_at',
    new Date(event.occurred_at).toISOString(),
    'payload',
    JSON.stringify(event.payload),
    'headers',
    JSON.stringify(event.headers),
  ];
}

export class RedisStreamPublisher implements EventPublisher {
  constructor(private readonly redis: Redis) {}

  async publish(event: OutboxEventRow): Promise<void> {
    await this.redis.xadd(EVENTS_STREAM, 'MAXLEN', '~', STREAM_MAXLEN, '*', ...streamFields(event));
  }

  async publishDead(event: OutboxEventRow, reason: string): Promise<void> {
    await this.redis.xadd(
      DEAD_STREAM,
      'MAXLEN',
      '~',
      100_000,
      '*',
      ...streamFields(event),
      'reason',
      reason,
    );
  }
}
