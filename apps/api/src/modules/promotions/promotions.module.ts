import { Module } from '@nestjs/common';

import { TenancyModule } from '../tenancy/public/index.js';
import { CouponsService } from './coupons.service.js';
import { PriceListsService } from './price-lists.service.js';
import { PricingPreviewService } from './pricing-preview.service.js';
import { PromotionsService } from './promotions.service.js';
import {
  CouponsController,
  PriceListsController,
  PricingController,
  PromotionsController,
} from './promotions.controllers.js';
import { ScopeAccessService } from './scope-access.service.js';

/**
 * Price lists, promotions, coupons and the pricing preview (slice F3). The pricing engine itself
 * lives in @pos/domain-core; this module governs its configuration data and runs the engine for
 * `POST /v1/pricing/preview`. Tax rules and tax classes belong to the pricing (tax) module.
 */
@Module({
  imports: [TenancyModule],
  controllers: [PriceListsController, PromotionsController, CouponsController, PricingController],
  providers: [
    ScopeAccessService,
    PriceListsService,
    PromotionsService,
    CouponsService,
    PricingPreviewService,
  ],
  exports: [PriceListsService, PromotionsService, CouponsService, PricingPreviewService],
})
export class PromotionsModule {}
