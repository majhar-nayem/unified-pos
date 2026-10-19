import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS } from '../../kernel/public/index.js';

export interface LockoutPolicy {
  readonly maxAttempts: number;
  readonly windowSeconds: number;
  readonly lockSeconds: number;
}

export const DEFAULT_LOGIN_LOCKOUT: LockoutPolicy = {
  maxAttempts: 5,
  windowSeconds: 900,
  lockSeconds: 900,
};

/** Failure counters and locks in Redis (docs/02 §3.2: lockout counters live in Redis, events in audit). */
@Injectable()
export class LockoutService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async isLocked(key: string): Promise<number> {
    const ttl = await this.redis.ttl(`lock:${key}`);
    return ttl > 0 ? ttl : 0;
  }

  /** Returns the remaining lock seconds when this failure tripped the lock, else 0. */
  async recordFailure(
    key: string,
    policy: LockoutPolicy,
  ): Promise<{ attempts: number; lockedForSeconds: number }> {
    const counter = `fail:${key}`;
    const attempts = await this.redis.incr(counter);
    if (attempts === 1) await this.redis.expire(counter, policy.windowSeconds);
    if (attempts >= policy.maxAttempts) {
      await this.redis.set(`lock:${key}`, '1', 'EX', policy.lockSeconds);
      await this.redis.del(counter);
      return { attempts, lockedForSeconds: policy.lockSeconds };
    }
    return { attempts, lockedForSeconds: 0 };
  }

  async clear(key: string): Promise<void> {
    await this.redis.del(`fail:${key}`, `lock:${key}`);
  }
}
