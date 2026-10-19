import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from '@pos/db';
import { createLogger } from '@pos/observability';

import { PG_POOL } from '../kernel/public/index.js';
import { ExecutionService } from './execution.service.js';
import { IntentsService } from './intents.service.js';
import { PaymentsLedger } from './ledger.service.js';
import { PAYMENTS_CONFIG, type PaymentsConfig } from './payments.config.js';
import { PaymentsRunner, SYSTEM_CALLER } from './payments-runner.js';
import { RefundsService } from './refunds.service.js';
import type { IntentRow } from './rows.js';
import { WebhooksService } from './webhooks.service.js';

export interface SweepSummary {
  tenants: number;
  /** `processing` intents (a crashed submit) moved to `uncertain`. */
  stuckMovedToUncertain: number;
  /** `uncertain` intents that reached a certain state through the provider. */
  uncertainResolved: number;
  uncertainStillOpen: number;
  /** `uncertain_aged` exceptions raised. */
  escalated: number;
  refundsResolved: number;
  operationsRecovered: number;
  webhooksRetried: number;
  offlineExpired: number;
  errors: number;
}

const emptySummary = (): SweepSummary => ({
  tenants: 0,
  stuckMovedToUncertain: 0,
  uncertainResolved: 0,
  uncertainStillOpen: 0,
  escalated: 0,
  refundsResolved: 0,
  operationsRecovered: 0,
  webhooksRetried: 0,
  offlineExpired: 0,
  errors: 0,
});

/**
 * Stuck-payment sweeper and offline-expiry sweeper (docs/01 §7.3, §8.3). Runs in the `payments`
 * deployable (apps/payments) on an interval; tests call `sweep({ now })` directly with a virtual
 * clock. Comparisons against row timestamps use the supplied `now`, so a test can fast-forward.
 *
 * Tenants are iterated one by one under their own RLS context because the application role cannot
 * read across tenants (platform.tenants is the only cross-tenant table it may read).
 */
@Injectable()
export class SweepersService {
  private readonly logger = createLogger({ service: 'payments.sweepers' });
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<unknown> | null = null;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly runner: PaymentsRunner,
    private readonly ledger: PaymentsLedger,
    private readonly execution: ExecutionService,
    private readonly intents: IntentsService,
    private readonly refunds: RefundsService,
    private readonly webhooks: WebhooksService,
    @Inject(PAYMENTS_CONFIG) private readonly config: PaymentsConfig,
  ) {}

  /** Start the periodic sweep. Returns a stop function. */
  start(intervalMs = this.config.sweepIntervalMs): () => void {
    if (this.timer) return () => this.stop();
    this.timer = setInterval(() => {
      if (this.inFlight) return; // never overlap two sweeps
      this.inFlight = this.sweep()
        .catch((err: unknown) => this.logger.error({ err }, 'sweep failed'))
        .finally(() => {
          this.inFlight = null;
        });
    }, intervalMs);
    this.timer.unref();
    return () => this.stop();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Stop the loop and wait for a sweep that is already running, so shutdown never races the connection pool. */
  async drain(): Promise<void> {
    this.stop();
    await this.inFlight;
  }

  async activeTenantIds(): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      "SELECT id FROM platform.tenants WHERE status = 'active' ORDER BY id",
    );
    return result.rows.map((r) => r.id);
  }

  async sweep(options: { now?: Date; tenantIds?: readonly string[] } = {}): Promise<SweepSummary> {
    const now = options.now ?? new Date();
    const summary = emptySummary();
    const tenants = options.tenantIds ?? (await this.activeTenantIds());
    summary.tenants = tenants.length;
    for (const tenantId of tenants) {
      await this.guard(summary, () => this.sweepStuckAndUncertain(tenantId, now, summary));
      await this.guard(summary, () => this.sweepRefunds(tenantId, now, summary));
      await this.guard(summary, () => this.sweepOperations(tenantId, now, summary));
      await this.guard(summary, async () => {
        summary.webhooksRetried += await this.webhooks.retryPending(tenantId);
      });
      await this.guard(summary, () => this.sweepOfflineExpiry(tenantId, now, summary));
    }
    return summary;
  }

  private async guard(summary: SweepSummary, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      summary.errors += 1;
      this.logger.error(
        { err: error instanceof Error ? error.message : error },
        'sweep step failed',
      );
    }
  }

  // --- uncertain / stuck processing --------------------------------------------------------

  async sweepStuckAndUncertain(
    tenantId: string,
    now: Date,
    summary: SweepSummary = emptySummary(),
  ): Promise<void> {
    const stuckBefore = new Date(now.getTime() - this.config.stuckAfterMs);
    const stuck = await this.runner.system(tenantId, (uow) =>
      uow.db.query<{ id: string }>(
        `SELECT id FROM payments.payment_intents
          WHERE tenant_id = $1 AND status = 'processing' AND updated_at <= $2
          ORDER BY updated_at LIMIT 200`,
        [uow.tenantId, stuckBefore],
      ),
    );
    for (const { id } of stuck) {
      const moved = await this.runner.system(tenantId, async (uow) => {
        const intent = await this.ledger.lockIntent(uow.db, id);
        // Re-checked under the lock: the submit may have settled meanwhile.
        if (!intent || intent.status !== 'processing' || intent.updated_at > stuckBefore)
          return false;
        const open = await this.ledger.openAttempt(uow.db, id);
        if (open)
          await this.ledger.finishAttempt(uow.db, open.id, {
            status: 'timeout',
            errorCode: 'stuck_processing',
            errorMessage: 'No result was recorded; resolved by the sweeper',
          });
        await this.ledger.transition(uow, intent, 'uncertain', SYSTEM_CALLER, {
          kind: 'timeout',
          payload: { reason: 'stuck_processing_swept', stuckAfterMs: this.config.stuckAfterMs },
        });
        return true;
      });
      if (moved) summary.stuckMovedToUncertain += 1;
    }

    const uncertain = await this.runner.system(tenantId, (uow) =>
      uow.db.query<IntentRow>(
        `SELECT * FROM payments.payment_intents WHERE tenant_id = $1 AND status = 'uncertain' ORDER BY updated_at LIMIT 200`,
        [uow.tenantId],
      ),
    );
    const escalateBefore = new Date(now.getTime() - this.config.uncertainEscalateAfterMs);
    for (const intent of uncertain) {
      const status = await this.execution.resolveUncertain(tenantId, intent.id);
      if (status && status !== 'uncertain') {
        summary.uncertainResolved += 1;
        continue;
      }
      summary.uncertainStillOpen += 1;
      if (intent.updated_at <= escalateBefore) {
        const raised = await this.runner.system(tenantId, (uow) =>
          this.ledger.raiseException(uow.db, {
            kind: 'uncertain_aged',
            severity: 'high',
            subjectKind: 'payment_intent',
            subjectId: intent.id,
            details: {
              orderId: intent.order_id,
              amountMinor: intent.amount_minor.toString(),
              uncertainSince: intent.updated_at.toISOString(),
              providerReference: intent.provider_reference,
            },
          }),
        );
        if (raised) summary.escalated += 1;
      }
    }
  }

  private async sweepRefunds(tenantId: string, now: Date, summary: SweepSummary): Promise<void> {
    const stuckBefore = new Date(now.getTime() - this.config.stuckAfterMs);
    const rows = await this.runner.system(tenantId, (uow) =>
      this.refunds.stuck(uow.db, stuckBefore),
    );
    for (const refund of rows) {
      const status = await this.refunds.resolveRefund(tenantId, refund.id);
      if (status && status !== 'uncertain' && status !== 'processing') summary.refundsResolved += 1;
    }
  }

  private async sweepOperations(tenantId: string, now: Date, summary: SweepSummary): Promise<void> {
    const stuckBefore = new Date(now.getTime() - this.config.stuckAfterMs);
    const rows = await this.runner.system(tenantId, (uow) =>
      uow.db.query<{ intent_id: string }>(
        `SELECT DISTINCT a.intent_id FROM payments.payment_attempts a
           JOIN payments.payment_intents i ON i.tenant_id = a.tenant_id AND i.id = a.intent_id
          WHERE a.tenant_id = $1 AND a.status = 'started' AND a.operation IN ('capture','cancel','reverse')
            AND a.started_at <= $2 AND i.status IN ('authorized','captured')
          LIMIT 100`,
        [uow.tenantId, stuckBefore],
      ),
    );
    for (const { intent_id } of rows) {
      if (await this.execution.recoverOperation(tenantId, intent_id))
        summary.operationsRecovered += 1;
    }
  }

  // --- offline expiry (docs/01 §8.3) ----------------------------------------------------------

  /**
   * A stored offline payment whose window has passed without a forward can no longer be collected:
   * mark it expired, fail the intent, reopen the check and raise `offline_expired`.
   */
  async sweepOfflineExpiry(
    tenantId: string,
    now: Date,
    summary: SweepSummary = emptySummary(),
  ): Promise<void> {
    const due = await this.runner.system(tenantId, (uow) =>
      uow.db.query<{ id: string }>(
        `SELECT id FROM payments.payment_intents
          WHERE tenant_id = $1 AND offline AND forward_outcome IN ('pending','rescue_in_progress')
            AND offline_expires_at <= $2
          ORDER BY offline_expires_at LIMIT 200`,
        [uow.tenantId, now],
      ),
    );
    for (const { id } of due) {
      const expired = await this.runner.system(tenantId, async (uow) => {
        const intent = await this.ledger.lockIntent(uow.db, id);
        if (
          !intent ||
          !intent.offline ||
          (intent.forward_outcome !== 'pending' &&
            intent.forward_outcome !== 'rescue_in_progress') ||
          !intent.offline_expires_at ||
          intent.offline_expires_at > now
        )
          return false;
        await this.intents.failOffline(uow, intent, 'expired', SYSTEM_CALLER);
        return true;
      });
      if (expired) summary.offlineExpired += 1;
    }
  }
}
