import { type BucketConfig, assertBucketConfig } from './token-bucket.js';

export interface RateLimitConfig {
  readonly enabled: boolean;
  /** Authenticated callers: one bucket per tenant + principal (operators: per operator). */
  readonly principal: BucketConfig;
  /** Anonymous and failed-authentication requests: one bucket per client IP. */
  readonly anonymous: BucketConfig;
  readonly keyPrefix: string;
}

export const RATE_LIMIT_CONFIG = Symbol('RATE_LIMIT_CONFIG');

export const RATE_LIMIT_DEFAULTS = {
  enabled: true,
  principal: { capacity: 300, refillPerSecond: 100 },
  anonymous: { capacity: 60, refillPerSecond: 10 },
  keyPrefix: 'rl',
} as const satisfies RateLimitConfig;

/** What every test app gets unless it opts in. */
export const RATE_LIMIT_DISABLED: RateLimitConfig = { ...RATE_LIMIT_DEFAULTS, enabled: false };

function positiveNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  return value;
}

function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} must be a boolean, got "${raw}"`);
}

/**
 * RATE_LIMIT_ENABLED, RATE_LIMIT_CAPACITY / RATE_LIMIT_REFILL_PER_SECOND (per principal),
 * RATE_LIMIT_PUBLIC_CAPACITY / RATE_LIMIT_PUBLIC_REFILL_PER_SECOND (per IP). See .env.example.
 */
export function rateLimitConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  const config: RateLimitConfig = {
    enabled: flag(env, 'RATE_LIMIT_ENABLED', RATE_LIMIT_DEFAULTS.enabled),
    principal: {
      capacity: positiveNumber(env, 'RATE_LIMIT_CAPACITY', RATE_LIMIT_DEFAULTS.principal.capacity),
      refillPerSecond: positiveNumber(
        env,
        'RATE_LIMIT_REFILL_PER_SECOND',
        RATE_LIMIT_DEFAULTS.principal.refillPerSecond,
      ),
    },
    anonymous: {
      capacity: positiveNumber(
        env,
        'RATE_LIMIT_PUBLIC_CAPACITY',
        RATE_LIMIT_DEFAULTS.anonymous.capacity,
      ),
      refillPerSecond: positiveNumber(
        env,
        'RATE_LIMIT_PUBLIC_REFILL_PER_SECOND',
        RATE_LIMIT_DEFAULTS.anonymous.refillPerSecond,
      ),
    },
    keyPrefix: env.RATE_LIMIT_KEY_PREFIX?.trim() || RATE_LIMIT_DEFAULTS.keyPrefix,
  };
  assertBucketConfig(config.principal, 'RATE_LIMIT');
  assertBucketConfig(config.anonymous, 'RATE_LIMIT_PUBLIC');
  return config;
}
