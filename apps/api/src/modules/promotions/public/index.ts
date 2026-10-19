/** Public surface of the promotions module (price lists, promotions, coupons, pricing preview). */
export { PromotionsModule } from '../promotions.module.js';
export { PriceListsService } from '../price-lists.service.js';
export { PromotionsService } from '../promotions.service.js';
export { CouponsService, normaliseCouponCode } from '../coupons.service.js';
export { PricingPreviewService } from '../pricing-preview.service.js';
export { PRICING_PERMISSIONS } from '../permissions.js';
export { createPricingFixture } from '../fixtures.js';
export type { PricingFixture } from '../fixtures.js';
