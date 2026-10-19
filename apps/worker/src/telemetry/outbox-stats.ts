import { type Pool, withoutTenant } from '@pos/db';
import { createLogger } from '@pos/observability';
import type { Redis } from 'ioredis';

import { DEAD_STREAM, EVENTS_STREAM } from '../modules/outbox/public/index.js';
import type { RelayObservation } from '../modules/outbox/public/index.js';

export interface OutboxReading {
  readonly backlog: number;
  readonly oldestAgeSeconds: number;
  /** db = exact totals from audit.fn_outbox_stats(); relay = lower bound observed by the last relay pass. */
  readonly source: 'db' | 'relay';
}

const STATS_SQL = 'SELECT backlog, oldest_age_seconds FROM audit.fn_outbox_stats()';

/**
 * Backlog and oldest-event age for the outbox gauges. The relay cannot count across tenants itself (row level
 * security) so exact totals need the SECURITY DEFINER function in infra/sql/outbox-stats.sql. Until that migration is
 * applied the gauges fall back to what the relay observed: rows that failed to publish are certainly still pending,
 * and a full batch means at least a batch remains.
 */
export class OutboxStats {
  private readonly logger = createLogger({ service: 'worker.outbox-stats' });
  private dbFunction: 'unknown' | 'present' | 'missing' = 'unknown';

  constructor(
    private readonly pool: Pool,
    private readonly observe: () => RelayObservation,
  ) {}

  async read(): Promise<OutboxReading> {
    if (this.dbFunction !== 'missing') {
      try {
        const result = await withoutTenant(this.pool, (client) =>
          client.query<{ backlog: bigint | number | string; oldest_age_seconds: number | string }>(
            STATS_SQL,
          ),
        );
        const row = result.rows[0];
        this.dbFunction = 'present';
        return {
          backlog: Number(row?.backlog ?? 0),
          oldestAgeSeconds: Number(row?.oldest_age_seconds ?? 0),
          source: 'db',
        };
      } catch (error) {
        if ((error as { code?: string }).code !== '42883') throw error; // anything but "function does not exist"
        this.dbFunction = 'missing';
        this.logger.warn(
          'audit.fn_outbox_stats() is not installed; outbox gauges report relay-observed lower bounds (see infra/sql/outbox-stats.sql)',
        );
      }
    }
    const seen = this.observe();
    return {
      backlog:
        seen.failedAgesSeconds.length + (seen.claimed >= seen.batchSize ? seen.batchSize : 0),
      oldestAgeSeconds: seen.failedAgesSeconds.length > 0 ? Math.max(...seen.failedAgesSeconds) : 0,
      source: 'relay',
    };
  }
}

/** Pending entries and lag per consumer group, plus the dead-letter stream length. */
export async function streamLag(redis: Redis): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    const groups = (await redis.xinfo('GROUPS', EVENTS_STREAM)) as unknown[];
    for (const group of groups) {
      const fields = group as Array<string | number | null>;
      const map = new Map<string, string | number | null>();
      for (let i = 0; i + 1 < fields.length; i += 2)
        map.set(String(fields[i]), fields[i + 1] ?? null);
      const name = String(map.get('name'));
      out[`${EVENTS_STREAM}:${name}:pending`] = Number(map.get('pending') ?? 0);
      const lag = map.get('lag');
      if (lag !== null && lag !== undefined) out[`${EVENTS_STREAM}:${name}:lag`] = Number(lag);
    }
  } catch (error) {
    if (!(error instanceof Error && /no such key/i.test(error.message))) throw error;
  }
  out[DEAD_STREAM] = await redis.xlen(DEAD_STREAM);
  return out;
}
