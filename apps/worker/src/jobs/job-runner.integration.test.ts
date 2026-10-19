import { startRedis, type TestRedis } from '@pos/testing';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createBullConnection } from '../modules/outbox/public/index.js';
import { until } from '../test-support.js';

import { JobRunner, type JobRunnerOptions } from './job-runner.js';

describe('JobRunner on Redis', () => {
  let redisBox: TestRedis;
  const connections: Redis[] = [];
  const runners: JobRunner[] = [];
  let sequence = 0;

  const newQueueName = () => `it-${Date.now()}-${(sequence += 1)}`;
  function connection(): Redis {
    const c = createBullConnection(redisBox.url);
    connections.push(c);
    return c;
  }
  function runner(queueName: string, options: JobRunnerOptions = {}): JobRunner {
    const r = new JobRunner(connection(), { queueName, prefix: 'it', ...options });
    runners.push(r);
    return r;
  }

  beforeAll(async () => {
    redisBox = await startRedis();
  });

  afterEach(async () => {
    await Promise.all(runners.splice(0).map((r) => r.stop()));
  });

  afterAll(async () => {
    connections.forEach((c) => c.disconnect());
    await redisBox?.stop();
  });

  it('runs an enqueued job with its payload', async () => {
    const seen: unknown[] = [];
    const jobs = runner(newQueueName()).register<{ orderId: string }>({
      name: 'echo',
      handler: async ({ data, attempt }) => void seen.push({ ...data, attempt }),
    });
    await jobs.start();
    await jobs.enqueue('echo', { orderId: 'o-1' });
    await until(() => seen.length === 1, 'the job to run');
    expect(seen[0]).toEqual({ orderId: 'o-1', attempt: 1 });
    await until(async () => (await jobs.counts()).completed === 1, 'completion');
  });

  it('retries a failing job with backoff and completes on the third attempt', async () => {
    const attempts: number[] = [];
    const jobs = runner(newQueueName()).register({
      name: 'flaky',
      attempts: 3,
      backoffMs: 20,
      handler: async ({ attempt }) => {
        attempts.push(attempt);
        if (attempt < 3) throw new Error(`boom ${attempt}`);
      },
    });
    await jobs.start();
    await jobs.enqueue('flaky', {});
    await until(async () => (await jobs.counts()).completed === 1, 'the job to complete');
    expect(attempts).toEqual([1, 2, 3]);
    expect((await jobs.counts()).failed).toBe(0);
  });

  it('keeps a job in the failed set once its attempts are exhausted', async () => {
    let calls = 0;
    const jobs = runner(newQueueName()).register({
      name: 'always-fails',
      attempts: 2,
      backoffMs: 10,
      handler: async () => {
        calls += 1;
        throw new Error('permanent');
      },
    });
    await jobs.start();
    await jobs.enqueue('always-fails', {});
    await until(async () => (await jobs.counts()).failed === 1, 'the job to be marked failed');
    expect(calls).toBe(2);
  });

  it('fails a job nobody handles immediately instead of retrying it', async () => {
    const name = newQueueName();
    const raw = new Queue(name, { connection: connection(), prefix: 'it' });
    await raw.add('ghost', {}, { attempts: 5 });
    const jobs = runner(name).register({ name: 'something-else', handler: async () => undefined });
    await jobs.start();
    await until(async () => (await jobs.counts()).failed === 1, 'the unhandled job to fail');
    const [failed] = await raw.getFailed();
    expect(failed!.attemptsMade).toBe(1);
    expect(failed!.failedReason).toMatch(/no handler registered/);
    await raw.close();
  });

  it('runs each scheduled tick once even with two worker replicas', async () => {
    const name = newQueueName();
    const ran: Array<{ replica: string; id: string }> = [];
    const replica = (label: string) =>
      runner(name, { concurrency: 2 }).register({
        name: 'tick',
        schedule: { everyMs: 250 },
        handler: async ({ id }) => void ran.push({ replica: label, id }),
      });
    const a = replica('a');
    const b = replica('b');
    await Promise.all([a.start(), b.start()]);
    await until(() => ran.length >= 4, 'four ticks', 15_000);

    const ids = ran.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length); // no tick ran twice
    expect(a.registered).toEqual(['tick']);
  });

  it('removes the scheduler of a job that is no longer registered', async () => {
    const name = newQueueName();
    const first = runner(name).register({
      name: 'old-report',
      schedule: { everyMs: 3_600_000 },
      handler: async () => undefined,
    });
    await first.start();
    await first.stop();

    const raw = new Queue(name, { connection: connection(), prefix: 'it' });
    expect((await raw.getJobSchedulers()).map((s) => s.key)).toEqual(['schedule:old-report']);

    const second = runner(name).register({
      name: 'new-report',
      schedule: { pattern: '0 3 * * *', tz: 'Australia/Sydney' },
      handler: async () => undefined,
    });
    await second.start();
    expect((await raw.getJobSchedulers()).map((s) => s.key)).toEqual(['schedule:new-report']);
    await raw.close();
  });
});
