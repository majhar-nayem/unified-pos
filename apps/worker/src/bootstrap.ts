import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { Pool } from '@pos/db';
import {
  createLogger,
  createRedMetrics,
  registerOperationalMetrics,
  startTelemetry,
  type Telemetry,
} from '@pos/observability';
import type { Redis } from 'ioredis';

import { registerBuiltinJobs } from './jobs/builtin-jobs.js';
import { JobRunner } from './jobs/job-runner.js';
import {
  EventLogConsumer,
  IdempotencyPurgeJob,
  OutboxRelayService,
  PG_POOL,
  REDIS,
  createBullConnection,
  type EventConsumer,
} from './modules/outbox/public/index.js';
import { OutboxStats, streamLag } from './telemetry/outbox-stats.js';
import { WorkerModule } from './worker.module.js';

const logger = createLogger({ service: 'worker' });

export interface RunningWorker {
  readonly relay: OutboxRelayService;
  readonly consumers: readonly EventConsumer[];
  readonly jobs: JobRunner;
  readonly telemetry: Telemetry;
  stop(): Promise<void>;
}

export interface StartWorkerOptions {
  /** Skip the BullMQ runner (unit tests that only need the relay). */
  readonly disableJobs?: boolean;
  readonly relayIdleDelayMs?: number;
}

/**
 * Worker bootstrap: telemetry, Postgres and Redis (fail fast when either is unreachable), outbox relay,
 * event consumer group, BullMQ job runner, operational gauges. No business consumers or jobs yet; slices register
 * theirs on `consumers` and `jobs`.
 */
export async function startWorker(options: StartWorkerOptions = {}): Promise<RunningWorker> {
  const telemetry = startTelemetry('worker', { serviceVersion: process.env.APP_VERSION });
  const red = createRedMetrics(telemetry.meter);

  const context = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error', 'warn'],
  });
  const relayModule = context.get(OutboxRelayService);
  const purge = context.get(IdempotencyPurgeJob);
  const redis = context.get<Redis>(REDIS);
  const pool = context.get<Pool>(PG_POOL);

  await verifyConnections(pool, redis);

  const stats = new OutboxStats(pool, () => relayModule.lastObservation);
  registerOperationalMetrics(
    {
      outboxBacklog: async () => (await stats.read()).backlog,
      outboxOldestAgeSeconds: async () => (await stats.read()).oldestAgeSeconds,
      streamLag: () => streamLag(redis),
    },
    { meter: telemetry.meter },
  );

  const consumer = new EventLogConsumer(redis, pool, {
    onBatch: (batch) =>
      red.recordOperation(`consumer.${batch.consumer}`, 'consumer', batch.durationMs, false),
  });
  const consumers: EventConsumer[] = [consumer];

  const bullConnection = createBullConnection();
  const jobs = new JobRunner(bullConnection, { red });
  registerBuiltinJobs(jobs, { purge });

  if (!options.disableJobs) await jobs.start();
  const stopRelay = relayModule.start();
  const stopConsumers = consumers.map((c) => c.start());
  logger.info(
    {
      jobs: jobs.registered,
      consumers: consumers.map((c) => c.name),
      telemetry: telemetry.enabled,
    },
    'worker started: outbox relay, consumer group, job runner',
  );

  let stopping: Promise<void> | undefined;
  return {
    relay: relayModule,
    consumers,
    jobs,
    telemetry,
    stop() {
      stopping ??= (async () => {
        await stopRelay();
        await Promise.all(stopConsumers.map((stop) => stop()));
        await jobs.stop();
        bullConnection.disconnect();
        await context.close();
        await pool.end().catch(() => undefined);
        redis.disconnect();
        await telemetry.shutdown();
        logger.info('worker stopped');
      })();
      return stopping;
    },
  };
}

/** Both stores must answer before the worker claims to be running; ECS replaces a task that exits here. */
export async function verifyConnections(pool: Pool, redis: Redis): Promise<void> {
  await pool.query('SELECT 1');
  if (redis.status === 'wait') await redis.connect();
  const pong = await redis.ping();
  if (pong !== 'PONG') throw new Error(`unexpected Redis reply: ${pong}`);
}
