import { Redis } from 'ioredis';

export const REDIS = Symbol('REDIS');
export const PG_POOL = Symbol('PG_POOL');

export function createRedis(url = process.env.REDIS_URL ?? 'redis://localhost:6379'): Redis {
  return new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
}

/** BullMQ workers block on Redis, which requires maxRetriesPerRequest to be null. */
export function createBullConnection(
  url = process.env.REDIS_URL ?? 'redis://localhost:6379',
): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}
