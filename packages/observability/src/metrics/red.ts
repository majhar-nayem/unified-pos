import { metrics, type Meter } from '@opentelemetry/api';

/** Rate, errors, duration (docs/01-system-architecture.md §13: "RED per endpoint"). */

export type OperationKind = 'queue' | 'job' | 'consumer' | 'outbox' | 'provider' | 'db' | 'other';

export interface HttpSample {
  /** Route template (`/v1/orders/:id`), never the raw URL: raw paths explode metric cardinality. */
  readonly route?: string;
  readonly method: string;
  readonly status: number;
  readonly durationMs: number;
}

export interface RedMetrics {
  readonly http: { record(sample: HttpSample): void };
  /** Time `fn`, count it, and count it as an error when it throws. */
  operation<T>(name: string, kind: OperationKind, fn: () => Promise<T>): Promise<T>;
  recordOperation(name: string, kind: OperationKind, durationMs: number, failed: boolean): void;
}

const DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 200, 300, 500, 1000, 2500, 5000, 10000];

export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

export function createRedMetrics(meter: Meter = metrics.getMeter('pos.red')): RedMetrics {
  const requests = meter.createCounter('pos.http.server.requests', {
    unit: '{request}',
    description: 'HTTP requests handled',
  });
  const errors = meter.createCounter('pos.http.server.errors', {
    unit: '{request}',
    description: 'HTTP responses with status 5xx',
  });
  const duration = meter.createHistogram('pos.http.server.duration', {
    unit: 'ms',
    description: 'HTTP server request duration',
    advice: { explicitBucketBoundaries: DURATION_BUCKETS_MS },
  });
  const operations = meter.createCounter('pos.operation.count', {
    unit: '{operation}',
    description: 'Background operations run',
  });
  const operationErrors = meter.createCounter('pos.operation.errors', {
    unit: '{operation}',
    description: 'Background operations that failed',
  });
  const operationDuration = meter.createHistogram('pos.operation.duration', {
    unit: 'ms',
    description: 'Background operation duration',
    advice: { explicitBucketBoundaries: DURATION_BUCKETS_MS },
  });

  function recordOperation(
    name: string,
    kind: OperationKind,
    durationMs: number,
    failed: boolean,
  ): void {
    const attributes = { operation: name, kind };
    operations.add(1, attributes);
    operationDuration.record(durationMs, attributes);
    if (failed) operationErrors.add(1, attributes);
  }

  return {
    http: {
      record(sample) {
        const attributes = {
          'http.route': sample.route ?? 'unmatched',
          'http.request.method': sample.method.toUpperCase(),
          'http.response.status_class': statusClass(sample.status),
        };
        requests.add(1, attributes);
        duration.record(sample.durationMs, attributes);
        // Client errors are not SLO errors; only server faults count against availability.
        if (sample.status >= 500) errors.add(1, attributes);
      },
    },
    recordOperation,
    async operation(name, kind, fn) {
      const started = process.hrtime.bigint();
      try {
        const result = await fn();
        recordOperation(name, kind, Number(process.hrtime.bigint() - started) / 1e6, false);
        return result;
      } catch (error) {
        recordOperation(name, kind, Number(process.hrtime.bigint() - started) / 1e6, true);
        throw error;
      }
    },
  };
}
