import { Module, type OnApplicationBootstrap, type OnModuleDestroy, Inject } from '@nestjs/common';

import { ProviderAccountsController, TerminalsController } from './http/accounts.controller.js';
import { IntentsController } from './http/intents.controller.js';
import { SettlementController } from './http/settlement.controller.js';
import { WebhooksController } from './http/webhooks.controller.js';
import { EXECUTION_FAULTS, ExecutionService } from './execution.service.js';
import { IntentsService } from './intents.service.js';
import { PaymentsLedger } from './ledger.service.js';
import { PAYMENTS_CONFIG, paymentsConfigFromEnv } from './payments.config.js';
import { PAYMENTS_PORT, PaymentsFacade } from './payments.port.js';
import { PaymentsRunner } from './payments-runner.js';
import { ORDER_PORT, SqlOrderPortStub } from './ports/order.port.js';
import { EnvPaymentSecrets, PAYMENT_SECRETS } from './ports/secrets.port.js';
import { ProviderAccountsService } from './provider-accounts.service.js';
import { PROVIDER_REGISTRY, defaultProviderRegistry } from './providers/provider-registry.js';
import { REFUND_FAULTS, RefundsService } from './refunds.service.js';
import { SettlementService } from './settlement.service.js';
import { SweepersService } from './sweepers.service.js';
import { TerminalsService } from './terminals.service.js';
import { WebhooksService } from './webhooks.service.js';

/**
 * Payments core (F5). Mounted by the API composition root (routes) and by the separate `payments`
 * deployable (apps/payments: webhook intake, sweepers, its own secrets). Set
 * PAYMENTS_SWEEPERS_ENABLED=true on exactly the process that should run the sweepers.
 */
@Module({
  controllers: [
    ProviderAccountsController,
    TerminalsController,
    IntentsController,
    WebhooksController,
    SettlementController,
  ],
  providers: [
    { provide: PAYMENTS_CONFIG, useFactory: () => paymentsConfigFromEnv() },
    { provide: PROVIDER_REGISTRY, useFactory: () => defaultProviderRegistry() },
    { provide: PAYMENT_SECRETS, useFactory: () => new EnvPaymentSecrets() },
    { provide: ORDER_PORT, useFactory: () => new SqlOrderPortStub() },
    { provide: EXECUTION_FAULTS, useValue: {} },
    { provide: REFUND_FAULTS, useValue: {} },
    PaymentsRunner,
    PaymentsLedger,
    ProviderAccountsService,
    TerminalsService,
    IntentsService,
    ExecutionService,
    RefundsService,
    WebhooksService,
    SettlementService,
    SweepersService,
    PaymentsFacade,
    { provide: PAYMENTS_PORT, useExisting: PaymentsFacade },
  ],
  exports: [
    PAYMENTS_PORT,
    PaymentsFacade,
    SweepersService,
    IntentsService,
    ExecutionService,
    RefundsService,
    WebhooksService,
    SettlementService,
    PROVIDER_REGISTRY,
    PAYMENT_SECRETS,
    ORDER_PORT,
    PAYMENTS_CONFIG,
  ],
})
export class PaymentsModule implements OnApplicationBootstrap, OnModuleDestroy {
  private stop: (() => void) | null = null;

  constructor(@Inject(SweepersService) private readonly sweepers: SweepersService) {}

  onApplicationBootstrap(): void {
    if (process.env.PAYMENTS_SWEEPERS_ENABLED === 'true') this.stop = this.sweepers.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.stop?.();
    await this.sweepers.drain();
  }
}
