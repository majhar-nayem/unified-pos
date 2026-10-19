import { Global, Module, type OnModuleDestroy, Inject } from '@nestjs/common';
import { createPool, databaseUrlFromEnv, type Pool } from '@pos/db';
import { Redis } from 'ioredis';

export const PG_POOL = Symbol('PG_POOL');
export const REDIS = Symbol('REDIS');

/** Pool and Redis client from DATABASE_URL / REDIS_URL; tests override the providers. */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: (): Pool =>
        createPool({
          connectionString: databaseUrlFromEnv(),
          max: Number(process.env.DATABASE_POOL_MAX ?? 10),
          applicationName: 'pos-api',
        }),
    },
    {
      provide: REDIS,
      useFactory: (): Redis =>
        new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
          lazyConnect: true,
          maxRetriesPerRequest: 2,
          enableOfflineQueue: true,
        }),
    },
  ],
  exports: [PG_POOL, REDIS],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end().catch(() => undefined);
    this.redis.disconnect();
  }
}
