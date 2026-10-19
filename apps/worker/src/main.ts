import 'reflect-metadata';

import { createLogger } from '@pos/observability';

import { startWorker } from './bootstrap.js';

const logger = createLogger({ service: 'worker' });

async function main(): Promise<void> {
  const worker = await startWorker();

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'worker stopping');
    worker.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ err: error }, 'worker failed to stop cleanly');
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'worker failed to start');
  process.exit(1);
});
