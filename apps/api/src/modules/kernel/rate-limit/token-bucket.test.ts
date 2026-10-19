import { describe, expect, it } from 'vitest';

import { RATE_LIMIT_DEFAULTS, rateLimitConfigFromEnv } from './rate-limit.config.js';
import { rateLimitSubject } from './rate-limit.guard.js';
import { type BucketConfig, bucketTtlMs, takeToken } from './token-bucket.js';

const config: BucketConfig = { capacity: 5, refillPerSecond: 2 };

describe('token bucket arithmetic', () => {
  it('a fresh bucket is full and the first take leaves capacity - 1', () => {
    const d = takeToken(undefined, 1_000, config);
    expect(d).toEqual({
      allowed: true,
      remaining: 4,
      retryAfterMs: 0,
      state: { tokens: 4, updatedAt: 1_000 },
    });
  });

  it('drains to zero, then refuses with the time until one token refills', () => {
    let state = undefined as ReturnType<typeof takeToken>['state'] | undefined;
    for (let i = 0; i < 5; i++) {
      const d = takeToken(state, 1_000, config);
      expect(d.allowed).toBe(true);
      expect(d.remaining).toBe(4 - i);
      state = d.state;
    }
    const refused = takeToken(state, 1_000, config);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterMs).toBe(500); // 1 token at 2/s
    expect(refused.state.tokens).toBe(0);
    const stillRefused = takeToken(refused.state, 1_250, config);
    expect(stillRefused).toMatchObject({ allowed: false, retryAfterMs: 250 });
    expect(stillRefused.state.tokens).toBeCloseTo(0.5);
    expect(takeToken(stillRefused.state, 1_500, config).allowed).toBe(true);
  });

  it('refills proportionally to elapsed time and never beyond capacity', () => {
    const empty = { tokens: 0, updatedAt: 0 };
    expect(takeToken(empty, 1_000, config).state.tokens).toBe(1); // 2 refilled, 1 taken
    expect(takeToken(empty, 60_000, config).state.tokens).toBe(4); // capped at 5, 1 taken
    expect(takeToken({ tokens: 3, updatedAt: 5_000 }, 4_000, config).state.tokens).toBe(2); // clock went backwards: no refill
  });

  it('a cost above capacity is never allowed and reports the full refill time', () => {
    const d = takeToken(undefined, 0, config, 7);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBe(1_000);
  });

  it('the key TTL covers a full refill plus a second of slack', () => {
    expect(bucketTtlMs(config)).toBe(3_500);
    expect(bucketTtlMs({ capacity: 300, refillPerSecond: 100 })).toBe(4_000);
  });
});

describe('rate limit configuration', () => {
  it('uses the documented defaults when nothing is set', () => {
    expect(rateLimitConfigFromEnv({})).toEqual(RATE_LIMIT_DEFAULTS);
  });

  it('reads every RATE_LIMIT_* variable', () => {
    expect(
      rateLimitConfigFromEnv({
        RATE_LIMIT_ENABLED: 'off',
        RATE_LIMIT_CAPACITY: '10',
        RATE_LIMIT_REFILL_PER_SECOND: '2.5',
        RATE_LIMIT_PUBLIC_CAPACITY: '4',
        RATE_LIMIT_PUBLIC_REFILL_PER_SECOND: '1',
        RATE_LIMIT_KEY_PREFIX: 'api',
      }),
    ).toEqual({
      enabled: false,
      principal: { capacity: 10, refillPerSecond: 2.5 },
      anonymous: { capacity: 4, refillPerSecond: 1 },
      keyPrefix: 'api',
    });
  });

  it('rejects zero, negative, non-numeric and non-boolean values at boot', () => {
    expect(() => rateLimitConfigFromEnv({ RATE_LIMIT_CAPACITY: '0' })).toThrow(
      /RATE_LIMIT_CAPACITY/,
    );
    expect(() => rateLimitConfigFromEnv({ RATE_LIMIT_REFILL_PER_SECOND: '-1' })).toThrow(
      /RATE_LIMIT_REFILL_PER_SECOND/,
    );
    expect(() => rateLimitConfigFromEnv({ RATE_LIMIT_PUBLIC_CAPACITY: 'lots' })).toThrow(
      /RATE_LIMIT_PUBLIC_CAPACITY/,
    );
    expect(() => rateLimitConfigFromEnv({ RATE_LIMIT_ENABLED: 'maybe' })).toThrow(
      /RATE_LIMIT_ENABLED/,
    );
  });
});

describe('rate limit subject', () => {
  const cfg = rateLimitConfigFromEnv({});
  const base = {
    tenantId: 't1',
    subjectId: 'u1',
    mfaVerified: false,
    assignmentsVersion: 1,
    assignments: [],
  } as const;

  it('anonymous requests share one bucket per IP and fail closed', () => {
    expect(rateLimitSubject(null, '10.0.0.1', cfg)).toEqual({
      key: 'ip:10.0.0.1',
      bucket: cfg.anonymous,
      failOpen: false,
    });
    expect(rateLimitSubject(null, undefined, cfg).key).toBe('ip:unknown');
  });

  it('tenant principals are keyed by tenant + kind + subject; pos and device tokens fail open', () => {
    expect(rateLimitSubject({ ...base, kind: 'user', tokenKind: 'web' }, '1.1.1.1', cfg)).toEqual({
      key: 't1:user:u1',
      bucket: cfg.principal,
      failOpen: false,
    });
    expect(
      rateLimitSubject({ ...base, kind: 'user', tokenKind: 'pos' }, '1.1.1.1', cfg).failOpen,
    ).toBe(true);
    expect(
      rateLimitSubject({ ...base, kind: 'device', tokenKind: 'device' }, '1.1.1.1', cfg),
    ).toMatchObject({ key: 't1:device:u1', failOpen: true });
    expect(
      rateLimitSubject({ ...base, kind: 'api_client', tokenKind: 'api' }, '1.1.1.1', cfg).failOpen,
    ).toBe(false);
  });

  it('operators are keyed by operator id', () => {
    expect(
      rateLimitSubject({ kind: 'operator', operatorId: 'op-1', tenantId: null }, '1.1.1.1', cfg),
    ).toMatchObject({ key: 'operator:op-1', failOpen: false });
  });
});
