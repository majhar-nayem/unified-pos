export interface PaymentsConfig {
  /** A `processing` intent untouched for this long is treated as a crashed submit and swept to `uncertain`. */
  readonly stuckAfterMs: number;
  /** How often the sweepers run when started. Uncertain intents resolve within one interval plus one provider round trip. */
  readonly sweepIntervalMs: number;
  /** An `uncertain` intent still unresolved after this long raises an `uncertain_aged` reconciliation exception. */
  readonly uncertainEscalateAfterMs: number;
  /** Default offline window (hours) when the provider account does not set one. */
  readonly offlineWindowHours: number;
}

export const PAYMENTS_CONFIG = Symbol('PAYMENTS_CONFIG');

export const PAYMENTS_CONFIG_DEFAULTS: PaymentsConfig = {
  stuckAfterMs: 30_000,
  sweepIntervalMs: 10_000,
  uncertainEscalateAfterMs: 15 * 60_000,
  offlineWindowHours: 24,
};

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function paymentsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PaymentsConfig {
  return {
    stuckAfterMs: positiveInt(
      env,
      'PAYMENTS_STUCK_AFTER_MS',
      PAYMENTS_CONFIG_DEFAULTS.stuckAfterMs,
    ),
    sweepIntervalMs: positiveInt(
      env,
      'PAYMENTS_SWEEP_INTERVAL_MS',
      PAYMENTS_CONFIG_DEFAULTS.sweepIntervalMs,
    ),
    uncertainEscalateAfterMs: positiveInt(
      env,
      'PAYMENTS_UNCERTAIN_ESCALATE_AFTER_MS',
      PAYMENTS_CONFIG_DEFAULTS.uncertainEscalateAfterMs,
    ),
    offlineWindowHours: positiveInt(
      env,
      'PAYMENTS_OFFLINE_WINDOW_HOURS',
      PAYMENTS_CONFIG_DEFAULTS.offlineWindowHours,
    ),
  };
}
