import { Module } from '@nestjs/common';

import { OutboxModule } from './modules/outbox/public/index.js';

/**
 * Worker root. Phase 1 wires the same domain modules as apps/api here (docs/03-implementation-plan.md §2)
 * so consumers and jobs run through the normal application services.
 */
@Module({ imports: [OutboxModule] })
export class WorkerModule {}
