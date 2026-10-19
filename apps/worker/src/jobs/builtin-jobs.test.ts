import { describe, expect, it } from 'vitest';

import { registerBuiltinJobs } from './builtin-jobs.js';
import { JobRunner, type JobDefinition } from './job-runner.js';

describe('built-in jobs', () => {
  it('schedules the idempotency purge hourly and runs it through the purge job', async () => {
    const registered: JobDefinition[] = [];
    const runner = {
      register: (definition: JobDefinition) => registered.push(definition),
    } as unknown as JobRunner;
    let purged = 0;
    registerBuiltinJobs(runner, { purge: { runOnce: async () => ++purged } as never });

    expect(registered.map((d) => d.name)).toEqual(['idempotency.purge']);
    expect(registered[0]!.schedule).toEqual({ everyMs: 3_600_000 });
    await registered[0]!.handler({ id: '1', name: 'idempotency.purge', data: {}, attempt: 1 });
    expect(purged).toBe(1);
  });
});

describe('JobRunner registration', () => {
  const runner = () => new JobRunner({} as never);

  it('rejects duplicate names', () => {
    const r = runner().register({ name: 'a', handler: async () => undefined });
    expect(() => r.register({ name: 'a', handler: async () => undefined })).toThrow(
      /already registered/,
    );
    expect(r.registered).toEqual(['a']);
  });

  it('refuses to enqueue before start()', async () => {
    await expect(
      runner()
        .register({ name: 'a', handler: async () => undefined })
        .enqueue('a', {}),
    ).rejects.toThrow(/start\(\)/);
  });
});
