import { Module } from '@nestjs/common';

import { TenancyModule } from '../tenancy/public/index.js';
import { AvailabilityService } from './availability/availability.service.js';
import {
  BarcodesAndComponentsController,
  CategoriesController,
  ItemsController,
  TaxClassesController,
  UnitsController,
  VariantsController,
} from './catalog.controllers.js';
import {
  AvailabilityController,
  MenuDetailsController,
  MenusController,
  ModifierGroupsController,
  ModifiersController,
} from './catalog.menu.controllers.js';
import {
  CatalogImportController,
  SupplierItemsController,
  SuppliersController,
} from './catalog.supplier.controllers.js';
import { CatalogPortService } from './catalog-port.service.js';
import { CatalogSeedService } from './catalog-seed.service.js';
import { CategoriesService } from './categories/categories.service.js';
import { CatalogImportService } from './import/import.service.js';
import { ComponentsService } from './items/components.service.js';
import { ItemsService } from './items/items.service.js';
import { MenusService } from './menus/menus.service.js';
import { ModifiersService } from './modifiers/modifiers.service.js';
import { SuppliersService } from './suppliers/suppliers.service.js';
import { TaxClassesService } from './tax-classes/tax-classes.service.js';
import { UnitsService } from './units/units.service.js';

@Module({
  imports: [TenancyModule],
  controllers: [
    CategoriesController,
    TaxClassesController,
    UnitsController,
    ItemsController,
    VariantsController,
    BarcodesAndComponentsController,
    ModifierGroupsController,
    ModifiersController,
    MenusController,
    MenuDetailsController,
    AvailabilityController,
    SuppliersController,
    SupplierItemsController,
    CatalogImportController,
  ],
  providers: [
    CategoriesService,
    TaxClassesService,
    UnitsService,
    ItemsService,
    ComponentsService,
    ModifiersService,
    MenusService,
    AvailabilityService,
    SuppliersService,
    CatalogImportService,
    CatalogSeedService,
    CatalogPortService,
  ],
  exports: [CatalogPortService, CatalogSeedService, TaxClassesService, ItemsService, UnitsService],
})
export class CatalogModule {}
