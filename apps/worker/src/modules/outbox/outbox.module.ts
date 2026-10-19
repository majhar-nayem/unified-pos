import { Module } from '@nestjs/common';
import { createPool, databaseUrlFromEnv } from '@pos/db';

import { IdempotencyPurgeJob } from './idempotency-purge.job.js';
import { EVENT_PUBLISHER, OutboxRelayService } from './outbox-relay.service.js';
import { RedisStreamPublisher } from './publisher.js';
import { PG_POOL, REDIS, createRedis } from './redis.provider.js';

@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: () =>
        createPool({
          connectionString: databaseUrlFromEnv(),
          max: 4,
          applicationName: 'pos-worker',
        }),
    },
    { provide: REDIS, useFactory: () => createRedis() },
    {
      provide: EVENT_PUBLISHER,
      useFactory: (redis: ConstructorParameters<typeof RedisStreamPublisher>[0]) =>
        new RedisStreamPublisher(redis),
      inject: [REDIS],
    },
    {
      provide: OutboxRelayService,
      useFactory: (pool, publisher) => new OutboxRelayService(pool, publisher),
      inject: [PG_POOL, EVENT_PUBLISHER],
    },
    IdempotencyPurgeJob,
  ],
  exports: [OutboxRelayService, IdempotencyPurgeJob, PG_POOL, REDIS],
})
export class OutboxModule {}
