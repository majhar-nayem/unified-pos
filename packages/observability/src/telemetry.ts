import { metrics, type Meter } from '@opentelemetry/api';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, type LogRecordExporter } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader, type IMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

import { RedactingLogRecordProcessor, RedactingSpanProcessor } from './processors.js';
import { telemetryState } from './state.js';

export interface TelemetryOptions {
  readonly serviceVersion?: string;
  /** dev, staging, prod-au. Defaults to DEPLOYMENT_ENVIRONMENT, then NODE_ENV. */
  readonly environment?: string;
  /** OTLP/HTTP base URL of the collector. Defaults to OTEL_EXPORTER_OTLP_ENDPOINT; without one telemetry stays off. */
  readonly endpoint?: string;
  /** Force on or off. Default: on when an endpoint (or an injected exporter) exists and OTEL_SDK_DISABLED is not "true". */
  readonly enabled?: boolean;
  /** Fraction of root traces kept (parent-based). Default OTEL_TRACES_SAMPLER_ARG, else 0.1 in production and 1 elsewhere. */
  readonly traceSampleRatio?: number;
  readonly metricExportIntervalMs?: number;
  /** false = none; default HTTP, pg and ioredis. They only patch modules loaded after start: use `node --import @pos/observability/register`. */
  readonly instrumentations?: boolean | Instrumentation[];
  readonly resourceAttributes?: Record<string, string>;
  /** Test seams: replace the OTLP exporters. */
  readonly spanExporter?: SpanExporter;
  readonly metricReader?: IMetricReader;
  readonly logRecordExporter?: LogRecordExporter;
}

export interface Telemetry {
  readonly serviceName: string;
  readonly enabled: boolean;
  /** A meter named after the service; a no-op meter while telemetry is off. */
  readonly meter: Meter;
  forceFlush(): Promise<void>;
  /** Flush and stop. Call from the application's shutdown path. */
  shutdown(): Promise<void>;
}

let current: Telemetry | undefined;

export function getTelemetry(): Telemetry | undefined {
  return current;
}

function defaultSampleRatio(environment: string): number {
  const fromEnv = Number(process.env.OTEL_TRACES_SAMPLER_ARG);
  if (process.env.OTEL_TRACES_SAMPLER_ARG !== undefined && Number.isFinite(fromEnv)) {
    return Math.min(1, Math.max(0, fromEnv));
  }
  return environment === 'dev' || environment === 'test' || environment === 'development' ? 1 : 0.1;
}

function defaultInstrumentations(): Instrumentation[] {
  return [
    new HttpInstrumentation({
      // Load balancer health checks would otherwise dominate the trace volume.
      ignoreIncomingRequestHook: (request) => (request.url ?? '').startsWith('/v1/health'),
    }),
    new PgInstrumentation({ enhancedDatabaseReporting: false, requireParentSpan: true }),
    // Command name only: keys and arguments can carry personal data.
    new IORedisInstrumentation({
      dbStatementSerializer: (command) => command,
      requireParentSpan: true,
    }),
  ];
}

/**
 * Start OpenTelemetry for a service: traces, metrics and logs over OTLP/HTTP to the collector, with PII
 * redaction on spans and log records. Idempotent. Safe without a collector: telemetry stays off and every API
 * (spans, meters, `withSpan`) turns into a no-op, so local development and tests need no setup.
 */
export function startTelemetry(serviceName: string, options: TelemetryOptions = {}): Telemetry {
  if (current) return current;

  const environment =
    options.environment ??
    process.env.DEPLOYMENT_ENVIRONMENT ??
    process.env.NODE_ENV ??
    'development';
  const endpoint = (options.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT)?.replace(
    /\/+$/,
    '',
  );
  const injected = Boolean(
    options.spanExporter ?? options.metricReader ?? options.logRecordExporter,
  );
  const enabled =
    options.enabled ??
    (process.env.OTEL_SDK_DISABLED !== 'true' && (Boolean(endpoint) || injected));

  if (!enabled) {
    current = {
      serviceName,
      enabled: false,
      meter: metrics.getMeter(serviceName),
      forceFlush: async () => undefined,
      shutdown: async () => {
        current = undefined;
      },
    };
    return current;
  }

  const url = (signal: 'traces' | 'metrics' | 'logs') =>
    endpoint ? { url: `${endpoint}/v1/${signal}` } : {};
  const spanExporter = options.spanExporter ?? new OTLPTraceExporter(url('traces'));
  const logExporter = options.logRecordExporter ?? new OTLPLogExporter(url('logs'));
  const metricReader =
    options.metricReader ??
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(url('metrics')),
      exportIntervalMillis: options.metricExportIntervalMs ?? 15_000,
    });

  const spanProcessor = new RedactingSpanProcessor(new BatchSpanProcessor(spanExporter));
  const logProcessor = new RedactingLogRecordProcessor(
    new BatchLogRecordProcessor({ exporter: logExporter }),
  );

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      ...(options.serviceVersion ? { [ATTR_SERVICE_VERSION]: options.serviceVersion } : {}),
      'deployment.environment.name': environment,
      ...options.resourceAttributes,
    }),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(
        options.traceSampleRatio ?? defaultSampleRatio(environment),
      ),
    }),
    spanProcessors: [spanProcessor],
    logRecordProcessors: [logProcessor],
    metricReader,
    instrumentations:
      options.instrumentations === false
        ? []
        : Array.isArray(options.instrumentations)
          ? options.instrumentations
          : defaultInstrumentations(),
  });
  sdk.start();
  telemetryState.active = true;

  let stopped: Promise<void> | undefined;
  current = {
    serviceName,
    enabled: true,
    meter: metrics.getMeter(serviceName),
    async forceFlush() {
      await Promise.all([
        spanProcessor.forceFlush(),
        logProcessor.forceFlush(),
        metricReader.forceFlush(),
      ]);
    },
    shutdown() {
      stopped ??= sdk.shutdown().finally(() => {
        telemetryState.active = false;
        current = undefined;
      });
      return stopped;
    },
  };
  return current;
}
