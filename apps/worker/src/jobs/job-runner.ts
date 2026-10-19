import { type Logger, type RedMetrics, createLogger, withSpan } from '@pos/observability';
import { type JobsOptions, Queue, UnrecoverableError, Worker } from 'bullmq';
import type { Redis } from 'ioredis';

/**
 * BullMQ job runner skeleton (docs/01-system-architecture.md §4.1: scheduled jobs live in the worker).
 *
 * - Handlers are registered by name; this module carries no business handlers.
 * - Scheduled jobs use BullMQ job schedulers, so with several worker replicas each tick runs exactly once.
 * - Jobs are at-least-once: handlers must be idempotent (the same rule as event consumers).
 * - Failed jobs retry with exponential backoff; exhausted jobs stay in the failed set for inspection.
 */

export type JobSchedule =
  { readonly everyMs: number } | { readonly pattern: string; readonly tz?: string };

export interface JobContext<T = unknown> {
  readonly id: string;
  readonly name: string;
  readonly data: T;
  /** 1 for the first run. */
  readonly attempt: number;
}

export interface JobDefinition<T = unknown> {
  readonly name: string;
  readonly handler: (context: JobContext<T>) => Promise<void>;
  readonly schedule?: JobSchedule;
  /** Payload of scheduled runs. */
  readonly data?: T;
  readonly attempts?: number;
  readonly backoffMs?: number;
}

export interface JobRunnerOptions {
  readonly queueName?: string;
  readonly prefix?: string;
  readonly concurrency?: number;
  readonly red?: RedMetrics;
  readonly logger?: Logger;
}

const SCHEDULER_PREFIX = 'schedule:';

export class JobRunner {
  private readonly definitions = new Map<string, JobDefinition<never>>();
  private readonly logger: Logger;
  private readonly queueName: string;
  private queue: Queue | undefined;
  private worker: Worker | undefined;

  constructor(
    /** Created with maxRetriesPerRequest: null (see createBullConnection). */
    private readonly connection: Redis,
    private readonly options: JobRunnerOptions = {},
  ) {
    this.logger = options.logger ?? createLogger({ service: 'worker.jobs' });
    this.queueName = options.queueName ?? 'pos-jobs';
  }

  register<T>(definition: JobDefinition<T>): this {
    if (this.queue) throw new Error('register jobs before start()');
    if (this.definitions.has(definition.name))
      throw new Error(`job "${definition.name}" is already registered`);
    this.definitions.set(definition.name, definition as unknown as JobDefinition<never>);
    return this;
  }

  get registered(): readonly string[] {
    return [...this.definitions.keys()];
  }

  async start(): Promise<void> {
    if (this.queue) return;
    const prefix = this.options.prefix ?? 'pos';
    const queue = new Queue(this.queueName, {
      connection: this.connection,
      prefix,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
    this.queue = queue;

    // Drop schedulers of jobs that no longer exist in this build, then (re)register the current ones.
    const stale = (await queue.getJobSchedulers(0, -1)).filter(
      (scheduler) =>
        scheduler.key.startsWith(SCHEDULER_PREFIX) &&
        !this.definitions.has(scheduler.key.slice(SCHEDULER_PREFIX.length)),
    );
    for (const scheduler of stale) await queue.removeJobScheduler(scheduler.key);

    for (const definition of this.definitions.values()) {
      if (!definition.schedule) continue;
      const repeat =
        'everyMs' in definition.schedule
          ? { every: definition.schedule.everyMs }
          : {
              pattern: definition.schedule.pattern,
              ...(definition.schedule.tz ? { tz: definition.schedule.tz } : {}),
            };
      await queue.upsertJobScheduler(`${SCHEDULER_PREFIX}${definition.name}`, repeat, {
        name: definition.name,
        data: definition.data ?? {},
        opts: this.jobOptions(definition),
      });
    }

    this.worker = new Worker(
      this.queueName,
      (job) => this.process(job.name, job.id ?? '', job.data, job.attemptsMade + 1),
      {
        connection: this.connection,
        prefix,
        concurrency: this.options.concurrency ?? 5,
      },
    );
    this.worker.on('failed', (job, error) =>
      this.logger.warn(
        { job: job?.name, jobId: job?.id, attempt: job?.attemptsMade, err: error },
        'job attempt failed',
      ),
    );
    this.worker.on('error', (error) => this.logger.error({ err: error }, 'job worker error'));
    await this.worker.waitUntilReady();
    this.logger.info({ jobs: this.registered, queue: this.queueName }, 'job runner started');
  }

  async enqueue<T>(name: string, data: T, options: JobsOptions = {}): Promise<string> {
    if (!this.queue) throw new Error('start() the runner first');
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`job "${name}" is not registered`);
    const job = await this.queue.add(name, data, { ...this.jobOptions(definition), ...options });
    return job.id ?? '';
  }

  /** Counts per state, for tests and health reporting. */
  async counts(): Promise<Record<string, number>> {
    if (!this.queue) throw new Error('start() the runner first');
    return this.queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    this.worker = undefined;
    this.queue = undefined;
  }

  private jobOptions(definition: JobDefinition<never>): JobsOptions {
    return {
      ...(definition.attempts !== undefined ? { attempts: definition.attempts } : {}),
      ...(definition.backoffMs !== undefined
        ? { backoff: { type: 'exponential', delay: definition.backoffMs } }
        : {}),
    };
  }

  private async process(name: string, id: string, data: unknown, attempt: number): Promise<void> {
    const definition = this.definitions.get(name);
    if (!definition) throw new UnrecoverableError(`no handler registered for job "${name}"`);
    const run = () =>
      withSpan(
        this.logger,
        `job ${name}`,
        () => definition.handler({ id, name, data: data as never, attempt }),
        {
          'job.name': name,
          'job.id': id,
          'job.attempt': attempt,
        },
      );
    if (this.options.red) await this.options.red.operation(name, 'job', run);
    else await run();
  }
}
