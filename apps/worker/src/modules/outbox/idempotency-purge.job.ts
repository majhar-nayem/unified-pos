import { Inject, Injectable } from '@nestjs/common';
import { type Pool, purgeExpiredIdempotencyKeys, withoutTenant } from '@pos/db';
import { createLogger } from '@pos/observability';

import { PG_POOL } from './redis.provider.js';

/** Hourly: drop idempotency keys past their 24 h expiry (docs/02 §3.13). */
@Injectable()
export class IdempotencyPurgeJob {
  private readonly logger = createLogger({ service: 'worker.idempotency-purge' });
  private timer: NodeJS.Timeout | null = null;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  start(intervalMs = 60 * 60 * 1000): () => void {
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    this.timer.unref();
    return () => {
      if (this.timer) clearInterval(this.timer);
    };
  }

  async runOnce(): Promise<number> {
    const purged = await withoutTenant(this.pool, (client) => purgeExpiredIdempotencyKeys(client));
    if (purged > 0) this.logger.info({ purged }, 'expired idempotency keys purged');
    return purged;
  }
}
