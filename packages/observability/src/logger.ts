import { isSpanContextValid, SpanStatusCode, trace } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { multistream, pino, stdSerializers, type Logger, type LoggerOptions } from 'pino';

import { redactObject, scrubString } from './redact.js';
import { telemetryState } from './state.js';

export type { Logger } from 'pino';

export interface LoggerConfig {
  readonly service: string;
  readonly level?: string;
  readonly pretty?: boolean;
  /** Merged into every log line (request correlation ids from AsyncLocalStorage, for example). */
  readonly mixin?: () => Record<string, unknown>;
  /** Replaces stdout (tests). */
  readonly stream?: { write(line: string): void };
}

/** Column names that must never be logged (PCI scope, docs/01-system-architecture.md §11). Fast path; deep redaction follows. */
const REDACT_PATHS = [
  '*.pin',
  '*.refreshToken',
  '*.clientSecret',
  '*.pan',
  '*.cvv',
  '*.card_number',
  '*.password',
  '*.secret',
  '*.token',
  'req.headers.authorization',
  'req.headers.cookie',
];

/** trace_id and span_id of the active span, so a log line can be joined to its trace. */
export function traceFields(): Record<string, string> {
  const context = trace.getActiveSpan()?.spanContext();
  if (!context || !isSpanContextValid(context)) return {};
  return { trace_id: context.traceId, span_id: context.spanId };
}

const SEVERITY: Record<number, readonly [SeverityNumber, string]> = {
  10: [SeverityNumber.TRACE, 'TRACE'],
  20: [SeverityNumber.DEBUG, 'DEBUG'],
  30: [SeverityNumber.INFO, 'INFO'],
  40: [SeverityNumber.WARN, 'WARN'],
  50: [SeverityNumber.ERROR, 'ERROR'],
  60: [SeverityNumber.FATAL, 'FATAL'],
};

type LogAttributeValue = string | number | boolean;

function toAttributes(fields: Record<string, unknown>): Record<string, LogAttributeValue> {
  const out: Record<string, LogAttributeValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    out[key] =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? value
        : JSON.stringify(value);
  }
  return out;
}

/** Forwards each pino line to the OpenTelemetry logs SDK once startTelemetry has run; a no-op before that. */
const otelLogStream = {
  write(line: string): void {
    if (!telemetryState.active) return;
    try {
      const {
        level,
        time,
        msg,
        pid: _pid,
        hostname: _hostname,
        err,
        ...rest
      } = JSON.parse(line) as Record<string, unknown>;
      const [severityNumber, severityText] = SEVERITY[Number(level)] ?? SEVERITY[30]!;
      const attributes = toAttributes(rest);
      if (err && typeof err === 'object') {
        const e = err as { type?: string; message?: string; stack?: string };
        if (e.type) attributes['exception.type'] = e.type;
        if (e.message) attributes['exception.message'] = e.message;
        if (e.stack) attributes['exception.stacktrace'] = e.stack;
      }
      logs.getLogger('pos').emit({
        severityNumber,
        severityText,
        body: typeof msg === 'string' ? msg : '',
        attributes,
        timestamp: typeof time === 'number' ? time : Date.now(),
      });
    } catch {
      // logging must never throw
    }
  },
};

export function createLogger(config: LoggerConfig): Logger {
  const userMixin = config.mixin;
  const options: LoggerOptions = {
    name: config.service,
    level: config.level ?? process.env.LOG_LEVEL ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: config.service },
    mixin: () => ({ ...traceFields(), ...(userMixin ? userMixin() : {}) }),
    formatters: {
      // Deep, pattern-aware redaction on every structured line.
      log: (object) => redactObject(object),
    },
    serializers: {
      err: (error: unknown) => {
        // pino hands the value through untouched when it is not an Error (callers often log `err: message`).
        const serialised = stdSerializers.err(error as Error) as unknown;
        if (typeof serialised === 'string') return scrubString(serialised);
        if (serialised === null || typeof serialised !== 'object') return serialised;
        const fields = serialised as { message?: unknown; stack?: unknown };
        return {
          ...fields,
          ...(typeof fields.message === 'string' ? { message: scrubString(fields.message) } : {}),
          ...(typeof fields.stack === 'string' ? { stack: scrubString(fields.stack) } : {}),
        };
      },
    },
    hooks: {
      // Free-text messages are scrubbed too.
      logMethod(args, method) {
        const scrubbed = args.map((arg) => (typeof arg === 'string' ? scrubString(arg) : arg));
        return method.apply(this, scrubbed as Parameters<typeof method>);
      },
    },
  };
  const destination = multistream([
    { stream: config.stream ?? process.stdout, level: 'trace' },
    { stream: otelLogStream, level: 'trace' },
  ]);
  return pino(options, destination);
}

/**
 * Runs `fn` inside an OpenTelemetry span (a no-op tracer until startTelemetry runs) and logs duration and
 * outcome, so call sites keep working with or without a collector.
 */
export async function withSpan<T>(
  logger: Logger,
  name: string,
  fn: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  const started = process.hrtime.bigint();
  return trace.getTracer('pos').startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn();
      logger.debug({ span: name, durationMs: elapsedMs(started), ok: true });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      logger.warn({ span: name, durationMs: elapsedMs(started), ok: false, err: error });
      throw error;
    } finally {
      span.end();
    }
  });
}

function elapsedMs(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}
