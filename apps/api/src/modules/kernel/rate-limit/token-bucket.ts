/**
 * Token bucket (docs/01 §5.1 step 1). The same arithmetic exists twice: here, so it can be unit
 * tested, and in TOKEN_BUCKET_LUA, which Redis runs atomically per key. Keep them in step.
 */

export interface BucketConfig {
  /** Burst size: tokens a full bucket holds. */
  readonly capacity: number;
  /** Sustained rate. */
  readonly refillPerSecond: number;
}

export interface BucketState {
  readonly tokens: number;
  /** Epoch milliseconds of the last update. */
  readonly updatedAt: number;
}

export interface BucketDecision {
  readonly allowed: boolean;
  /** Whole tokens left after this decision. */
  readonly remaining: number;
  /** 0 when allowed; otherwise how long until `cost` tokens are available. */
  readonly retryAfterMs: number;
  readonly state: BucketState;
}

export function assertBucketConfig(config: BucketConfig, label = 'bucket'): void {
  if (!Number.isFinite(config.capacity) || config.capacity <= 0)
    throw new Error(`${label}: capacity must be a positive number`);
  if (!Number.isFinite(config.refillPerSecond) || config.refillPerSecond <= 0)
    throw new Error(`${label}: refillPerSecond must be a positive number`);
}

/** Refill by elapsed time, then take `cost` tokens if available. Pure. */
export function takeToken(
  state: BucketState | undefined,
  now: number,
  config: BucketConfig,
  cost = 1,
): BucketDecision {
  const previousTokens = state?.tokens ?? config.capacity;
  const elapsedMs = state ? Math.max(0, now - state.updatedAt) : 0;
  const tokens = Math.min(
    config.capacity,
    previousTokens + (elapsedMs * config.refillPerSecond) / 1000,
  );
  if (tokens >= cost) {
    const left = tokens - cost;
    return {
      allowed: true,
      remaining: Math.floor(left),
      retryAfterMs: 0,
      state: { tokens: left, updatedAt: now },
    };
  }
  return {
    allowed: false,
    remaining: Math.floor(tokens),
    retryAfterMs: Math.ceil(((cost - tokens) * 1000) / config.refillPerSecond),
    state: { tokens, updatedAt: now },
  };
}

/** How long a key must live for an idle bucket to be full again when it is next read. */
export function bucketTtlMs(config: BucketConfig): number {
  return Math.ceil((config.capacity / config.refillPerSecond) * 1000) + 1000;
}

/**
 * KEYS[1] bucket; ARGV: capacity, refillPerSecond, now (ms), cost, ttl (ms).
 * Returns { allowed (0|1), remaining (floor), retryAfterMs }.
 */
export const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
local stored = redis.call('HMGET', KEYS[1], 'tokens', 'updated')
local tokens = tonumber(stored[1])
local updated = tonumber(stored[2])
if tokens == nil or updated == nil then
  tokens = capacity
  updated = now
end
local elapsed = now - updated
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + (elapsed * refill) / 1000)
local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil(((cost - tokens) * 1000) / refill)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'updated', tostring(now))
redis.call('PEXPIRE', KEYS[1], ttl)
return { allowed, math.floor(tokens), retry }
`;
