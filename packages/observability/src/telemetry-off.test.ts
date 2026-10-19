import { describe, expect, it } from 'vitest';

import { createLogger, withSpan } from './logger.js';
import { createRedMetrics } from './metrics/red.js';
import { startTelemetry } from './telemetry.js';

describe('telemetry without a collector', () => {
  it('stays off, and spans, meters and loggers keep working as no-ops', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const telemetry = startTelemetry('local-dev');
    expect(telemetry.enabled).toBe(false);

    const lines: string[] = [];
    const logger = createLogger({
      service: 'local-dev',
      level: 'debug',
      stream: { write: (line) => void lines.push(line) },
    });
    await expect(withSpan(logger, 'noop', async () => 42)).resolves.toBe(42);
    createRedMetrics(telemetry.meter).http.record({ method: 'GET', status: 200, durationMs: 1 });
    await telemetry.forceFlush();
    expect(lines.length).toBeGreaterThan(0);
    await telemetry.shutdown();
  });

  it('honours OTEL_SDK_DISABLED even when an endpoint is set', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
    process.env.OTEL_SDK_DISABLED = 'true';
    try {
      expect(startTelemetry('disabled').enabled).toBe(false);
    } finally {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      delete process.env.OTEL_SDK_DISABLED;
    }
  });
});
