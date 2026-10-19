import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { describe, expect, it } from 'vitest';

import { registerOperationalMetrics, WindowedCounter } from './operational.js';
import { createRedMetrics, statusClass } from './red.js';

function harness() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = new MeterProvider({
    readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 })],
  });
  const read = async (
    name: string,
  ): Promise<Array<{ value: unknown; attributes: Record<string, unknown> }>> => {
    exporter.reset();
    await provider.forceFlush();
    return exporter
      .getMetrics()
      .flatMap((rm: ResourceMetrics) => rm.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .filter((metric) => metric.descriptor.name === name)
      .flatMap(
        (metric) =>
          metric.dataPoints as Array<{ value: unknown; attributes: Record<string, unknown> }>,
      );
  };
  return { provider, meter: provider.getMeter('test'), read };
}

describe('WindowedCounter', () => {
  it('counts events inside the window and forgets older ones', () => {
    let now = 1_000_000;
    const counter = new WindowedCounter(300_000, () => now);
    counter.record();
    now += 100_000;
    counter.record(2);
    expect(counter.count()).toBe(3);
    now += 250_000; // first event is now 350 s old
    expect(counter.count()).toBe(2);
    now += 100_000;
    expect(counter.count()).toBe(0);
  });
});

describe('RED metrics', () => {
  it('uses route templates and counts only 5xx as errors', async () => {
    const { meter, read } = harness();
    const red = createRedMetrics(meter);
    red.http.record({ route: '/v1/items/:id', method: 'post', status: 201, durationMs: 20 });
    red.http.record({ route: '/v1/items/:id', method: 'post', status: 500, durationMs: 90 });
    red.http.record({ method: 'get', status: 404, durationMs: 1 });

    const requests = await read('pos.http.server.requests');
    expect(requests).toHaveLength(3);
    expect(requests.map((p) => p.attributes['http.route']).sort()).toEqual([
      '/v1/items/:id',
      '/v1/items/:id',
      'unmatched',
    ]);
    expect(
      requests.every(
        (p) =>
          p.attributes['http.request.method'] ===
          p.attributes['http.request.method']?.toString().toUpperCase(),
      ),
    ).toBe(true);
    expect((await read('pos.http.server.errors')).map((p) => p.value)).toEqual([1]);
    const durations = (await read('pos.http.server.duration')) as Array<{
      value: { count: number };
    }>;
    expect(durations.reduce((sum, p) => sum + p.value.count, 0)).toBe(3);
  });

  it('classifies statuses', () => {
    expect([200, 301, 404, 503].map(statusClass)).toEqual(['2xx', '3xx', '4xx', '5xx']);
  });
});

describe('operational metrics', () => {
  it('observes probes, survives a failing probe and reports stream lag per stream', async () => {
    const { meter, read } = harness();
    registerOperationalMetrics(
      {
        outboxBacklog: () => 12,
        outboxOldestAgeSeconds: async () => 3,
        syncLagSeconds: () => {
          throw new Error('db unavailable');
        },
        streamLag: () => ({ 'pos:events': 4, 'pos:events:dead': 1 }),
      },
      { meter },
    );
    expect((await read('pos.outbox.backlog')).map((p) => p.value)).toEqual([12]);
    expect((await read('pos.outbox.oldest_age.seconds')).map((p) => p.value)).toEqual([3]);
    expect(await read('pos.sync.lag.seconds')).toEqual([]);
    const errors = (await read('pos.probe.errors'))[0]!;
    expect(errors.attributes).toEqual({ probe: 'pos.sync.lag.seconds' });
    expect(Number(errors.value)).toBeGreaterThanOrEqual(1); // cumulative: one per collection
    const lag = await read('pos.stream.lag');
    expect(lag.map((p) => [p.attributes.stream, p.value]).sort()).toEqual([
      ['pos:events', 4],
      ['pos:events:dead', 1],
    ]);
  });

  it('exposes event gauges that return to zero after the window, and totals that do not', async () => {
    const { meter, read } = harness();
    let now = 0;
    const operational = registerOperationalMetrics(
      {},
      { meter, now: () => now, windowMs: 300_000 },
    );
    expect((await read('pos.rls.context_missing')).map((p) => p.value)).toEqual([0]); // observed even when clean

    operational.recordRlsContextMissing();
    operational.recordAuditChainVerificationFailure();
    operational.recordCrossTenantAttempt({ route: '/v1/orders' });
    expect((await read('pos.rls.context_missing')).map((p) => p.value)).toEqual([1]);
    expect((await read('pos.audit.chain.verification_failures')).map((p) => p.value)).toEqual([1]);
    expect((await read('pos.cross_tenant.attempts')).map((p) => p.value)).toEqual([1]);

    now += 301_000;
    expect((await read('pos.rls.context_missing')).map((p) => p.value)).toEqual([0]);
    expect((await read('pos.rls.context_missing.total')).map((p) => p.value)).toEqual([1]);
  });
});
