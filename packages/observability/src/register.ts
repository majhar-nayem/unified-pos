/**
 * Preload entry: `node --import @pos/observability/register dist/main.js`.
 *
 * Registers the ESM loader hook that lets the HTTP, pg and ioredis instrumentations patch modules, then starts
 * telemetry for OTEL_SERVICE_NAME. Without OTEL_EXPORTER_OTLP_ENDPOINT it does nothing, so local runs are unaffected.
 * It must be a preload (not an import inside main.ts): ESM resolves the whole import graph before running any
 * module, which is too late to patch it.
 */
import { register } from 'node:module';

import { startTelemetry } from './telemetry.js';

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT && process.env.OTEL_SDK_DISABLED !== 'true') {
  try {
    register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  } catch {
    // Tracing of manually created spans still works without the loader hook.
  }
}

const telemetry = startTelemetry(
  process.env.OTEL_SERVICE_NAME ?? process.env.SERVICE_NAME ?? 'unknown-service',
);
process.once('beforeExit', () => {
  void telemetry.shutdown();
});
