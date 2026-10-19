import { Global, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { AuthorizationService } from './authz/authorization.service.js';
import { DatabaseModule } from './database.module.js';
import { OpenApiController } from './openapi/openapi.controller.js';
import { KernelPorts } from './ports.js';
import { RATE_LIMIT_CONFIG, rateLimitConfigFromEnv } from './rate-limit/rate-limit.config.js';
import { RequestContextMiddleware, RequestContextService } from './request-context.js';
import { TenantDirectory } from './tenant-directory.js';
import { UnitOfWork } from './unit-of-work.js';

/**
 * Cross-cutting request pipeline (docs/01 §5.1). The composition root (app.module.ts) registers the
 * global guards, interceptors and filter and binds KernelPorts to the identity/tenancy modules.
 */
@Global()
@Module({
  imports: [DatabaseModule, DiscoveryModule],
  controllers: [OpenApiController],
  providers: [
    RequestContextService,
    AuthorizationService,
    UnitOfWork,
    TenantDirectory,
    KernelPorts,
    { provide: RATE_LIMIT_CONFIG, useFactory: () => rateLimitConfigFromEnv() },
  ],
  exports: [
    RequestContextService,
    AuthorizationService,
    UnitOfWork,
    TenantDirectory,
    DatabaseModule,
    KernelPorts,
    RATE_LIMIT_CONFIG,
  ],
})
export class KernelModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
