import { Module } from '@nestjs/common';
import { orders } from '@pos/domain-core';

import { IdentityModule } from '../identity/public/index.js';
import { ApprovalGate } from './approval.gate.js';
import { CommandContextFactory } from './command-context.factory.js';
import { LocationReadModel } from './location.read-model.js';
import { OrderCommitter } from './order.committer.js';
import { OrderPortService } from './order-port.service.js';
import { OrderRepository } from './order.repository.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { CATALOG_PORT, PRICING_PORT } from './ports.js';

@Module({
  imports: [IdentityModule],
  controllers: [OrdersController],
  providers: [
    // STUBS until the integration slice: list price from the submitted line, GST 10 % inclusive, no promotions
    { provide: PRICING_PORT, useFactory: () => new orders.StubPricingPort() },
    { provide: CATALOG_PORT, useFactory: () => new orders.StubCatalogPort() },
    OrderRepository,
    OrderCommitter,
    LocationReadModel,
    ApprovalGate,
    CommandContextFactory,
    OrdersService,
    OrderPortService,
  ],
  exports: [
    OrderRepository,
    OrderCommitter,
    LocationReadModel,
    CommandContextFactory,
    OrderPortService,
    PRICING_PORT,
    CATALOG_PORT,
  ],
})
export class OrdersModule {}
