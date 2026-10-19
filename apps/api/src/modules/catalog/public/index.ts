/** Public surface of the catalog module. Other modules and the app shell import ONLY from here. */
export { CatalogModule } from '../catalog.module.js';
export { CatalogSeedService } from '../catalog-seed.service.js';
export { TaxClassesService } from '../tax-classes/tax-classes.service.js';
export { ItemsService } from '../items/items.service.js';
export { UnitsService, DEFAULT_UNITS, DEFAULT_CONVERSIONS } from '../units/units.service.js';
export { CatalogPortService } from '../catalog-port.service.js';
