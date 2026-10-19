import { Module, type OnModuleInit } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import {
  AuthGuard,
  ContractInterceptor,
  EtagInterceptor,
  GlobalExceptionFilter,
  IdempotencyInterceptor,
  KernelModule,
  KernelPorts,
  RateLimitGuard,
  ScopeGuard,
} from './modules/kernel/public/index.js';
import { AuditModule } from './modules/audit/public/index.js';
import { DevicesModule } from './modules/devices/public/index.js';
import {
  IdentityFirstAdminProvisioner,
  IdentityModule,
  JwtAuthenticator,
} from './modules/identity/public/index.js';
import { PlatformModule } from './modules/platform/public/index.js';
import { HierarchyService, TenancyModule } from './modules/tenancy/public/index.js';
import { CatalogModule } from './modules/catalog/public/index.js'; // F2 (S-F2)
import { PricingModule } from './modules/pricing/public/index.js'; // F2 (S-F2)
import { PromotionsModule } from './modules/promotions/public/index.js'; // F3 (S-F3)
import { PaymentsModule } from './modules/payments/public/index.js'; // F5 (S-F5)
import { OrdersModule } from './modules/orders/public/index.js'; // F4 (S-F4)
import { ReceiptsModule } from './modules/receipts/public/index.js'; // F4 (S-F4)

/**
 * Composition root. Domain modules from docs/01-system-architecture.md §5 register here as they
 * land; they import each other only through `modules/<name>/public` (tools/eslint/boundaries.js).
 *
 * Pipeline order (docs/01 §5.1): request context → RateLimitGuard → AuthGuard → ScopeGuard →
 * ContractInterceptor → IdempotencyInterceptor → EtagInterceptor → handler; GlobalExceptionFilter
 * maps every error.
 * The kernel's outbound ports (authenticator, scope resolver, first-admin provisioner) are bound
 * here, explicitly, to the modules that implement them.
 */
@Module({
  imports: [
    KernelModule,
    TenancyModule,
    PlatformModule,
    AuditModule,
    DevicesModule,
    IdentityModule,
    CatalogModule, // F2 (S-F2)
    PricingModule, // F2 (S-F2)
    PromotionsModule, // F3 (S-F3)
    PaymentsModule, // F5 (S-F5)
    OrdersModule, // F4 (S-F4)
    ReceiptsModule, // F4 (S-F4)
  ],
  providers: [
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: ScopeGuard },
    { provide: APP_INTERCEPTOR, useClass: ContractInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_INTERCEPTOR, useClass: EtagInterceptor },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule implements OnModuleInit {
  constructor(
    private readonly ports: KernelPorts,
    private readonly hierarchy: HierarchyService,
    private readonly authenticator: JwtAuthenticator,
    private readonly firstAdmin: IdentityFirstAdminProvisioner,
  ) {}

  onModuleInit(): void {
    this.ports.bind({
      scopeResolver: this.hierarchy,
      authenticator: this.authenticator,
      firstAdminProvisioner: this.firstAdmin,
    });
  }
}
