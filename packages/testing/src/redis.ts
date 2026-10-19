import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';

export const REDIS_IMAGE = 'redis:7';

export interface TestRedis {
  readonly container: StartedRedisContainer;
  readonly url: string;
  stop(): Promise<void>;
}

/** Start redis:7 for lockout counters, challenges and the outbox stream. */
export async function startRedis(): Promise<TestRedis> {
  const container = await new RedisContainer(REDIS_IMAGE).start();
  return {
    container,
    url: container.getConnectionUrl(),
    async stop() {
      await container.stop();
    },
  };
}
