import { type Pool, recordProcessedEvent, withoutTenant } from '@pos/db';
import { createLogger, type Logger } from '@pos/observability';
import type { Redis } from 'ioredis';

import { EVENTS_STREAM } from './publisher.js';

export interface StreamEvent {
  readonly streamId: string;
  readonly id: string;
  readonly tenantId: string;
  readonly locationId: string | null;
  readonly type: string;
  readonly aggregateKind: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number | null;
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
  readonly headers: Record<string, unknown>;
}

export function parseStreamEvent(streamId: string, fields: string[]): StreamEvent {
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) map.set(fields[i]!, fields[i + 1]!);
  const get = (k: string) => map.get(k) ?? '';
  return {
    streamId,
    id: get('id'),
    tenantId: get('tenant_id'),
    locationId: get('location_id') || null,
    type: get('type'),
    aggregateKind: get('aggregate_kind'),
    aggregateId: get('aggregate_id'),
    aggregateVersion: get('aggregate_version') === '' ? null : Number(get('aggregate_version')),
    occurredAt: get('occurred_at'),
    payload: JSON.parse(get('payload') || '{}') as Record<string, unknown>,
    headers: JSON.parse(get('headers') || '{}') as Record<string, unknown>,
  };
}

/**
 * Consumer-group reader over the events stream with exactly-once processing per consumer name
 * (audit.processed_events dedupes redeliveries). Subclasses implement `handle`.
 */
export interface ConsumerHooks {
  /** Called after each non-empty batch (metrics hook). */
  readonly onBatch?: (info: {
    consumer: string;
    processed: number;
    duplicates: number;
    durationMs: number;
  }) => void;
}

export abstract class EventConsumer {
  protected readonly logger: Logger;
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(
    public readonly name: string,
    private readonly redis: Redis,
    private readonly pool: Pool,
    private readonly stream: string = EVENTS_STREAM,
    private readonly blockMs = 1000,
    private readonly hooks: ConsumerHooks = {},
  ) {
    this.logger = createLogger({ service: `worker.consumer.${name}` });
  }

  protected abstract handle(event: StreamEvent): Promise<void>;

  async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', this.stream, this.name, '0', 'MKSTREAM');
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('BUSYGROUP'))) throw error;
    }
  }

  start(): () => Promise<void> {
    this.running = true;
    this.loop = this.run();
    return async () => {
      this.running = false;
      await this.loop;
    };
  }

  /** Read one batch (pending first, then new), process, ack. Returns processed count. Exposed for tests. */
  async readOnce(count = 100): Promise<number> {
    const results = (await this.redis.xreadgroup(
      'GROUP',
      this.name,
      `${this.name}-1`,
      'COUNT',
      count,
      'BLOCK',
      this.blockMs,
      'STREAMS',
      this.stream,
      '>',
    )) as Array<[string, Array<[string, string[]]>]> | null;
    if (!results) return 0;
    const startedAt = Date.now();
    let processed = 0;
    let duplicates = 0;
    for (const [, entries] of results) {
      for (const [streamId, fields] of entries) {
        const event = parseStreamEvent(streamId, fields);
        const first = await withoutTenant(this.pool, (client) =>
          recordProcessedEvent(client, this.name, event.id),
        );
        if (first) {
          await this.handle(event);
          processed += 1;
        } else {
          duplicates += 1;
          this.logger.debug({ eventId: event.id }, 'duplicate delivery skipped');
        }
        await this.redis.xack(this.stream, this.name, streamId);
      }
    }
    this.hooks.onBatch?.({
      consumer: this.name,
      processed,
      duplicates,
      durationMs: Date.now() - startedAt,
    });
    return processed;
  }

  private async run(): Promise<void> {
    await this.ensureGroup();
    while (this.running) {
      try {
        await this.readOnce();
      } catch (error) {
        this.logger.error({ err: error }, 'consumer loop failed');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
}

/** Skeleton consumer: logs every event. Real consumers (read models, notifications) arrive per slice. */
export class EventLogConsumer extends EventConsumer {
  readonly seen: StreamEvent[] = [];

  constructor(redis: Redis, pool: Pool, hooks: ConsumerHooks = {}) {
    super('event-log', redis, pool, EVENTS_STREAM, 1000, hooks);
  }

  protected async handle(event: StreamEvent): Promise<void> {
    this.seen.push(event);
    this.logger.info({ eventId: event.id, type: event.type, tenantId: event.tenantId }, 'event');
  }
}
