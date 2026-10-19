/** Public surface of the pricing module (F2: tax). Other modules and the app shell import ONLY from here. */
export { PricingModule } from '../pricing.module.js';
export { TaxRulesService } from '../tax/tax-rules.service.js';
export { AU_TAX_SEED, AU_GST_START } from '../tax/tax-seed.service.js';
