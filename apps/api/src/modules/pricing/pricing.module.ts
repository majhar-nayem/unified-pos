import { Global, Module } from '@nestjs/common';

import { CatalogModule, CatalogSeedService } from '../catalog/public/index.js';
import { TENANT_SEEDERS, type TenantSeeder } from '../platform/public/index.js';
import { TaxController } from './tax/tax.controllers.js';
import { TaxRulesService } from './tax/tax-rules.service.js';
import { TaxSeedService } from './tax/tax-seed.service.js';

/**
 * Pricing, F2 scope: tax rules and the AU GST seed. Price lists and promotions arrive with F3
 * (their own module). The seeders are published through the platform's TENANT_SEEDERS token (global,
 * because the platform module injects it without importing this module). Order matters: units first,
 * then tax classes and rules.
 */
@Global()
@Module({
  imports: [CatalogModule],
  controllers: [TaxController],
  providers: [
    TaxRulesService,
    TaxSeedService,
    {
      provide: TENANT_SEEDERS,
      inject: [CatalogSeedService, TaxSeedService],
      useFactory: (catalogSeed: CatalogSeedService, tax: TaxSeedService): TenantSeeder[] => [
        { name: 'catalog.units', seed: (uow) => catalogSeed.seedUnits(uow) },
        { name: 'pricing.au_gst', seed: (uow) => tax.seed(uow) },
      ],
    },
  ],
  exports: [TaxRulesService, TENANT_SEEDERS],
})
export class PricingModule {}
