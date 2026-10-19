import { Module } from '@nestjs/common';

import { BusinessDaysService } from './business-days.service.js';
import { ConfigService } from './config.service.js';
import { HierarchyService } from './hierarchy.service.js';
import { LegalEntitiesService } from './legal-entities.service.js';
import { LocationsService } from './locations.service.js';
import { OrgUnitsService } from './org-units.service.js';
import { RegistersService } from './registers.service.js';
import {
  ConfigController,
  LegalEntitiesController,
  LocationsController,
  OrgUnitsController,
  RegistersController,
  TenantsController,
} from './tenancy.controllers.js';
import { TenantSkeletonService } from './tenant-skeleton.service.js';

@Module({
  controllers: [
    TenantsController,
    OrgUnitsController,
    LegalEntitiesController,
    LocationsController,
    RegistersController,
    ConfigController,
  ],
  providers: [
    HierarchyService,
    OrgUnitsService,
    LegalEntitiesService,
    LocationsService,
    RegistersService,
    ConfigService,
    BusinessDaysService,
    TenantSkeletonService,
  ],
  exports: [
    HierarchyService,
    ConfigService,
    TenantSkeletonService,
    LocationsService,
    RegistersService,
  ],
})
export class TenancyModule {}
