import { context, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, withSpan } from './logger.js';
import { createRedMetrics } from './metrics/red.js';
import { registerOperationalMetrics } from './metrics/operational.js';
import { startTelemetry, type Telemetry } from './telemetry.js';

const spanExporter = new InMemorySpanExporter();
const logExporter = new InMemoryLogRecordExporter();
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);

let telemetry: Telemetry;

beforeAll(() => {
  telemetry = startTelemetry('test-service', {
    environment: 'test',
    instrumentations: false,
    spanExporter,
    logRecordExporter: logExporter,
    metricReader: new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 3_600_000,
    }),
  });
});

afterAll(async () => {
  await telemetry.shutdown();
});

function lastValue(name: string, attributes?: Record<string, unknown>): number | undefined {
  const all = metricExporter
    .getMetrics()
    .flatMap((rm: ResourceMetrics) => rm.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === name);
  const points = all.flatMap(
    (metric) => metric.dataPoints as Array<{ value: unknown; attributes: Record<string, unknown> }>,
  );
  const matching = attributes
    ? points.filter((p) => Object.entries(attributes).every(([k, v]) => p.attributes[k] === v))
    : points;
  const last = matching.at(-1);
  return last ? Number(last.value) : undefined;
}

describe('startTelemetry', () => {
  it('is enabled with injected exporters and idempotent', () => {
    expect(telemetry.enabled).toBe(true);
    expect(startTelemetry('another-name')).toBe(telemetry);
  });

  it('exports spans with the service resource and redacted attributes', async () => {
    const logger = createLogger({ service: 'test', stream: { write: () => undefined } });
    await withSpan(logger, 'checkout.commit', async () => 'ok', {
      'user.email': 'owner@acme.example',
      'http.route': '/v1/orders',
      'customer.note': 'receipt to owner@acme.example',
    });
    await telemetry.forceFlush();
    const span = spanExporter.getFinishedSpans().find((s) => s.name === 'checkout.commit');
    expect(span).toBeDefined();
    expect(span!.resource.attributes['service.name']).toBe('test-service');
    expect(span!.resource.attributes['deployment.environment.name']).toBe('test');
    expect(span!.attributes).toMatchObject({
      'user.email': '[redacted]',
      'http.route': '/v1/orders',
      'customer.note': 'receipt to [email]',
    });
  });

  it('marks a failing withSpan as an error and records the exception without secrets', async () => {
    const logger = createLogger({ service: 'test', stream: { write: () => undefined } });
    await expect(
      withSpan(logger, 'provider.call', async () => {
        throw new Error('rejected for owner@acme.example');
      }),
    ).rejects.toThrow();
    await telemetry.forceFlush();
    const span = spanExporter.getFinishedSpans().find((s) => s.name === 'provider.call')!;
    expect(span.status.code).toBe(2);
    const event = span.events.find((e) => e.name === 'exception')!;
    expect(String(event.attributes?.['exception.message'])).toBe('rejected for [email]');
  });

  it('sends log lines to the logs SDK, correlated with the active span and redacted', async () => {
    const logger = createLogger({ service: 'test', stream: { write: () => undefined } });
    let traceId = '';
    await withSpan(logger, 'with.logs', async () => {
      traceId = trace.getActiveSpan()!.spanContext().traceId;
      logger.info({ email: 'owner@acme.example', orderId: 'o-1' }, 'paid by owner@acme.example');
    });
    await telemetry.forceFlush();
    const record = logExporter.getFinishedLogRecords().find((r) => r.attributes.orderId === 'o-1')!;
    expect(record.body).toBe('paid by [email]');
    expect(record.attributes.email).toBe('[redacted]');
    expect(record.attributes.trace_id).toBe(traceId);
    expect(record.spanContext?.traceId).toBe(traceId);
    expect(record.severityText).toBe('INFO');
  });

  it('redacts log records emitted straight through the logs API, independent of pino', async () => {
    logs.getLogger('direct').emit({
      body: 'refund for owner@acme.example',
      attributes: { 'user.email': 'owner@acme.example', marker: 'direct' },
    });
    await telemetry.forceFlush();
    const record = logExporter
      .getFinishedLogRecords()
      .find((r) => r.attributes.marker === 'direct')!;
    expect(record.body).toBe('refund for [email]');
    expect(record.attributes['user.email']).toBe('[redacted]');
  });

  it('keeps an active context across awaits (AsyncLocalStorage context manager is installed)', async () => {
    await withSpan(
      createLogger({ service: 't', stream: { write: () => undefined } }),
      'outer',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(trace.getActiveSpan()?.spanContext().traceId).toBe(
          trace.getSpan(context.active())?.spanContext().traceId,
        );
        expect(trace.getActiveSpan()).toBeDefined();
      },
    );
  });

  it('exports RED and operational metrics through the same pipeline', async () => {
    const red = createRedMetrics(telemetry.meter);
    red.http.record({ route: '/v1/orders/:id', method: 'get', status: 200, durationMs: 12 });
    red.http.record({ route: '/v1/orders/:id', method: 'get', status: 503, durationMs: 40 });
    red.http.record({ route: '/v1/orders/:id', method: 'get', status: 404, durationMs: 5 });
    await expect(red.operation('outbox.relay', 'outbox', async () => 1)).resolves.toBe(1);
    await expect(
      red.operation('outbox.relay', 'outbox', async () => {
        throw new Error('broker down');
      }),
    ).rejects.toThrow('broker down');

    const operational = registerOperationalMetrics(
      { outboxBacklog: () => 7, paymentUncertainCount: async () => 2 },
      { meter: telemetry.meter },
    );
    operational.recordRlsContextMissing({ service: 'api' });

    await telemetry.forceFlush();
    expect(lastValue('pos.http.server.requests', { 'http.response.status_class': '2xx' })).toBe(1);
    expect(lastValue('pos.http.server.errors')).toBe(1); // only the 503 counts
    expect(lastValue('pos.operation.count', { operation: 'outbox.relay' })).toBe(2);
    expect(lastValue('pos.operation.errors', { operation: 'outbox.relay' })).toBe(1);
    expect(lastValue('pos.outbox.backlog')).toBe(7);
    expect(lastValue('pos.payment.uncertain.count')).toBe(2);
    expect(lastValue('pos.rls.context_missing')).toBe(1);
    expect(lastValue('pos.rls.context_missing.total')).toBe(1);
  });
});
