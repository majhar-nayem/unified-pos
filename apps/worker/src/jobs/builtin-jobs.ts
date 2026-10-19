import type { IdempotencyPurgeJob } from '../modules/outbox/public/index.js';

import type { JobRunner } from './job-runner.js';

/**
 * Jobs that belong to the platform skeleton itself. Business jobs (reconciliation, replenishment, reports,
 * retention) are registered by their slices; none exists yet.
 */
export function registerBuiltinJobs(
  runner: JobRunner,
  deps: { readonly purge: IdempotencyPurgeJob },
): void {
  runner.register({
    name: 'idempotency.purge',
    // Hourly; one run per tick across all worker replicas.
    schedule: { everyMs: 60 * 60 * 1000 },
    handler: async () => {
      await deps.purge.runOnce();
    },
  });
}
