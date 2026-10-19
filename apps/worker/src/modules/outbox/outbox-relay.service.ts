import { Inject, Injectable } from '@nestjs/common';
import {
  type Pool,
  claimOutboxBatch,
  markOutboxDead,
  markOutboxFailed,
  markOutboxPublished,
  withoutTenant,
} from '@pos/db';
import { createLogger } from '@pos/observability';

import { PG_POOL } from './redis.provider.js';
import { type EventPublisher } from './publisher.js';

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

export interface RelayPassInfo {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
  readonly dead: number;
  readonly durationMs: number;
}

export interface RelayOptions {
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  readonly idleDelayMs?: number;
  /** Called after every non-empty pass (metrics hook). */
  readonly onPass?: (info: RelayPassInfo) => void;
}

/** What the last pass saw; a truthful lower bound for the backlog gauges when the database cannot report totals. */
export interface RelayObservation {
  readonly batchSize: number;
  readonly claimed: number;
  /** Ages in seconds of rows whose publish failed in the last pass (they are still pending). */
  readonly failedAgesSeconds: readonly number[];
}

/**
 * Outbox relay (docs/01-system-architecture.md §9): claims unpublished rows across tenants through
 * the SECURITY DEFINER function (60 s lease), publishes them to the Redis stream and marks them.
 * Rows that exhausted their attempts go to the dead stream. At-least-once: consumers dedupe.
 */
@Injectable()
export class OutboxRelayService {
  private readonly logger = createLogger({ service: 'worker.outbox' });
  private running = false;
  private inFlight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly options: Required<Omit<RelayOptions, 'onPass'>> & Pick<RelayOptions, 'onPass'>;
  private observation: RelayObservation = { batchSize: 100, claimed: 0, failedAgesSeconds: [] };

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    options: RelayOptions = {},
  ) {
    this.options = {
      batchSize: options.batchSize ?? 100,
      maxAttempts: options.maxAttempts ?? 10,
      idleDelayMs: options.idleDelayMs ?? 250,
      onPass: options.onPass,
    };
    this.observation = { batchSize: this.options.batchSize, claimed: 0, failedAgesSeconds: [] };
  }

  get lastObservation(): RelayObservation {
    return this.observation;
  }

  /** Start the poll loop; returns a stop function that waits for the in-flight batch. */
  start(): () => Promise<void> {
    this.running = true;
    this.schedule(0);
    return () => this.stop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.inFlight) await this.inFlight;
  }

  /** One pass: claim → publish → mark. Returns how many rows were claimed. Exposed for tests and jobs. */
  async relayOnce(): Promise<number> {
    const startedAt = Date.now();
    const rows = await withoutTenant(this.pool, (client) =>
      claimOutboxBatch(client, this.options.batchSize, this.options.maxAttempts + 1),
    );
    if (rows.length === 0) {
      this.observation = { batchSize: this.options.batchSize, claimed: 0, failedAgesSeconds: [] };
      return 0;
    }
    const published: string[] = [];
    const failedAges: number[] = [];
    let dead = 0;
    for (const row of rows) {
      if (row.attempts > this.options.maxAttempts) {
        const reason = row.last_error ?? 'max attempts exceeded';
        await this.publisher.publishDead(row, reason);
        await withoutTenant(this.pool, (client) => markOutboxDead(client, row.id, reason));
        dead += 1;
        this.logger.error(
          {
            eventId: row.id,
            tenantId: row.tenant_id,
            type: row.event_type,
            attempts: row.attempts,
          },
          'outbox event moved to dead stream',
        );
        continue;
      }
      try {
        await this.publisher.publish(row);
        published.push(row.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await withoutTenant(this.pool, (client) => markOutboxFailed(client, row.id, message));
        failedAges.push(Math.max(0, (Date.now() - new Date(row.occurred_at).getTime()) / 1000));
        this.logger.warn(
          { eventId: row.id, attempts: row.attempts, err: message },
          'outbox publish failed',
        );
      }
    }
    await withoutTenant(this.pool, (client) => markOutboxPublished(client, published));
    this.observation = {
      batchSize: this.options.batchSize,
      claimed: rows.length,
      failedAgesSeconds: failedAges,
    };
    this.options.onPass?.({
      claimed: rows.length,
      published: published.length,
      failed: failedAges.length,
      dead,
      durationMs: Date.now() - startedAt,
    });
    return rows.length;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.relayOnce()
        .then((count) =>
          this.schedule(count >= this.options.batchSize ? 0 : this.options.idleDelayMs),
        )
        .catch((error: unknown) => {
          this.logger.error({ err: error }, 'outbox relay pass failed');
          this.schedule(this.options.idleDelayMs * 4);
        })
        .finally(() => {
          this.inFlight = null;
        });
    }, delayMs);
    this.timer.unref();
  }
}
