import { Inject, Module, type OnModuleInit } from '@nestjs/common';
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
} from '@pos/api/dist/modules/kernel/public/index.js';
import { PaymentsModule } from '@pos/api/dist/modules/payments/public/index.js';
import { HierarchyService, TenancyModule } from '@pos/api/dist/modules/tenancy/public/index.js';

/**
 * Composition root of the `payments` deployable (docs/01 ADR-019, plan §5 F5 "payments deployable
 * with separate secrets"). It mounts the SAME PaymentsModule as the API, plus the kernel pipeline
 * and the tenancy scope resolver, and nothing else: no identity module, so no login routes and no
 * token authenticator. Authenticated payment routes therefore fail closed (401) here; this process
 * serves the public, signature-verified webhook intake and runs the sweepers
 * (PAYMENTS_SWEEPERS_ENABLED, set by main.ts). Provider credentials and webhook secrets are read
 * from THIS process's environment only (PAYMENTS_WEBHOOK_SECRET__<REF>, STRIPE_*).
 */
@Module({
  imports: [KernelModule, TenancyModule, PaymentsModule],
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
export class PaymentsAppModule implements OnModuleInit {
  constructor(
    @Inject(KernelPorts) private readonly ports: KernelPorts,
    @Inject(HierarchyService) private readonly hierarchy: HierarchyService,
  ) {}

  onModuleInit(): void {
    // The authenticator stays the kernel's NullAuthenticator on purpose.
    this.ports.bind({ scopeResolver: this.hierarchy });
  }
}
