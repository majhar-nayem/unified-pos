export { createLogger, traceFields, withSpan } from './logger.js';
export type { Logger, LoggerConfig } from './logger.js';

export { getTelemetry, startTelemetry } from './telemetry.js';
export type { Telemetry, TelemetryOptions } from './telemetry.js';

export { RedactingLogRecordProcessor, RedactingSpanProcessor } from './processors.js';
export {
  REDACTED,
  isSensitiveKey,
  luhnValid,
  redactAttributesInPlace,
  redactObject,
  redactValue,
  scrubString,
} from './redact.js';
export type { RedactOptions } from './redact.js';

export { createRedMetrics, statusClass } from './metrics/red.js';
export type { HttpSample, OperationKind, RedMetrics } from './metrics/red.js';
export { WindowedCounter, registerOperationalMetrics } from './metrics/operational.js';
export type {
  OperationalMetrics,
  OperationalOptions,
  OperationalProbes,
} from './metrics/operational.js';

export {
  AVAILABILITY_SLO,
  ERROR_BUDGET,
  alertDocument,
  buildAlertDocument,
  burnRateAlert,
  serialiseAlertDocument,
} from './alerts/definitions.js';
export type {
  AlertDefinition,
  AlertDocument,
  CompositeDefinition,
  MetricQuery,
  MetricRef,
  Severity,
} from './alerts/definitions.js';
