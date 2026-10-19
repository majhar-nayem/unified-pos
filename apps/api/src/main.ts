import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { createLogger } from '@pos/observability';

import { AppModule } from './app.module.js';
import { API_PREFIX, RequestContextService } from './modules/kernel/public/index.js';

const logger = createLogger({ service: 'api', mixin: RequestContextService.logFields });

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
    rawBody: true, // payments webhooks verify the signature over the raw body (S-F5)
  });
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  logger.info({ port }, 'api listening');
}

bootstrap().catch((error: unknown) => {
  logger.error({ err: error }, 'api failed to start');
  process.exit(1);
});
