import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Module, type OnModuleInit } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PERMISSIONS, type PermissionKey, type Scope } from '@pos/auth';
import { PAYMENT_PERMISSIONS } from '@pos/contracts';
import { type Pool, createPool, newId } from '@pos/db';
import { MockPaymentProvider, MockTerminalAdapter, StripeProviderAdapter } from '@pos/payments-sdk';
import { Redis } from 'ioredis';

import {
  API_PREFIX,
  AuthGuard,
  ContractInterceptor,
  EtagInterceptor,
  GlobalExceptionFilter,
  IdempotencyInterceptor,
  KernelModule,
  KernelPorts,
  PG_POOL,
  RATE_LIMIT_CONFIG,
  RATE_LIMIT_DISABLED,
  REDIS,
  RateLimitGuard,
  ScopeGuard,
  TestAuthenticator,
  type TenantPrincipal,
} from '../../kernel/public/index.js';
import { HierarchyService, TenancyModule } from '../../tenancy/public/index.js';
import {
  EXECUTION_FAULTS,
  type ExecutionFaults,
  PAYMENTS_CONFIG,
  PAYMENT_SECRETS,
  PROVIDER_REGISTRY,
  PaymentsModule,
  ProviderRegistry,
  REFUND_FAULTS,
  type RefundFaults,
  StaticPaymentSecrets,
  SweepersService,
  type PaymentsConfig,
  PAYMENTS_CONFIG_DEFAULTS,
} from '../public/index.js';

export const WEBHOOK_SECRET = 'whsec_integration_test';

/** Same pipeline as AppModule (guards, interceptors, filter) but only the modules payments needs. */
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
class PaymentsTestRoot implements OnModuleInit {
  constructor(
    private readonly ports: KernelPorts,
    private readonly hierarchy: HierarchyService,
  ) {}

  onModuleInit(): void {
    this.ports.bind({ scopeResolver: this.hierarchy });
  }
}

export interface PaymentsTestApp {
  readonly app: INestApplication;
  readonly server: ReturnType<INestApplication['getHttpServer']>;
  readonly auth: TestAuthenticator;
  readonly pool: Pool;
  readonly provider: MockPaymentProvider;
  readonly terminal: MockTerminalAdapter;
  readonly registry: ProviderRegistry;
  readonly faults: ExecutionFaults;
  readonly refundFaults: RefundFaults;
  readonly sweepers: SweepersService;
  close(): Promise<void>;
}

export interface PaymentsTestAppOptions {
  readonly databaseUrl: string;
  readonly provider?: MockPaymentProvider;
  readonly config?: Partial<PaymentsConfig>;
}

export async function createPaymentsTestApp(
  options: PaymentsTestAppOptions,
): Promise<PaymentsTestApp> {
  const pool = createPool({
    connectionString: options.databaseUrl,
    max: 8,
    applicationName: 'pos-payments-test',
  });
  const auth = new TestAuthenticator();
  const provider = options.provider ?? new MockPaymentProvider({ webhookSecret: WEBHOOK_SECRET });
  const terminal = new MockTerminalAdapter(provider);
  const registry = new ProviderRegistry()
    .register(provider, terminal)
    .register(new StripeProviderAdapter({})); // no key: simulated
  const faults: ExecutionFaults = {};
  const refundFaults: RefundFaults = {};
  const moduleRef = await Test.createTestingModule({ imports: [PaymentsTestRoot] })
    .overrideProvider(PG_POOL)
    .useValue(pool)
    .overrideProvider(REDIS)
    .useValue(new Redis('redis://127.0.0.1:1', { lazyConnect: true, maxRetriesPerRequest: 0 }))
    .overrideProvider(RATE_LIMIT_CONFIG)
    .useValue(RATE_LIMIT_DISABLED)
    .overrideProvider(PROVIDER_REGISTRY)
    .useValue(registry)
    .overrideProvider(PAYMENT_SECRETS)
    .useValue(
      new StaticPaymentSecrets({ 'mock/main': WEBHOOK_SECRET, 'mock/other': WEBHOOK_SECRET }),
    )
    .overrideProvider(EXECUTION_FAULTS)
    .useValue(faults)
    .overrideProvider(REFUND_FAULTS)
    .useValue(refundFaults)
    .overrideProvider(PAYMENTS_CONFIG)
    .useValue({ ...PAYMENTS_CONFIG_DEFAULTS, ...options.config })
    .compile();
  const app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  app.setGlobalPrefix(API_PREFIX);
  await app.init();
  app.get(KernelPorts).bind({ authenticator: auth });
  return {
    app,
    server: app.getHttpServer(),
    auth,
    pool,
    provider,
    terminal,
    registry,
    faults,
    refundFaults,
    sweepers: app.get(SweepersService),
    async close() {
      await app.close();
      await pool.end().catch(() => undefined);
    },
  };
}

/** Every payments permission plus the refund key the refund route reuses. */
export const PAYMENT_TEST_PERMISSIONS: readonly PermissionKey[] = [
  ...Object.values(PAYMENT_PERMISSIONS),
  'orders.refund.create',
];

export function paymentsPrincipal(
  tenantId: string,
  scope: Scope,
  permissions: readonly PermissionKey[] = PAYMENT_TEST_PERMISSIONS,
): TenantPrincipal {
  return {
    tenantId,
    subjectId: newId(),
    kind: 'user',
    mfaVerified: true,
    assignmentsVersion: 1,
    assignments: [{ assignmentId: newId(), role: 'test', permissions, scope, coveredScopeIds: [] }],
    tokenKind: 'web',
  };
}

export const ALL_CATALOG_PERMISSIONS: readonly PermissionKey[] = PERMISSIONS.map((p) => p.key);
