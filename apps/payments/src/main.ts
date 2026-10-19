import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { API_PREFIX, RequestContextService } from '@pos/api/dist/modules/kernel/public/index.js';
import { createLogger } from '@pos/observability';

import { PaymentsAppModule } from './payments-app.module.js';

const logger = createLogger({ service: 'payments', mixin: RequestContextService.logFields });

async function bootstrap(): Promise<void> {
  // This process owns the sweepers unless an operator explicitly turns them off.
  process.env.PAYMENTS_SWEEPERS_ENABLED ??= 'true';
  // rawBody: provider webhook signatures are computed over the exact bytes received.
  const app = await NestFactory.create(PaymentsAppModule, {
    rawBody: true,
    logger: ['error', 'warn', 'log'],
  });
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3100);
  await app.listen(port);
  logger.info(
    { port, sweepers: process.env.PAYMENTS_SWEEPERS_ENABLED === 'true' },
    'payments listening',
  );
}

bootstrap().catch((error: unknown) => {
  logger.error({ err: error }, 'payments failed to start');
  process.exit(1);
});
