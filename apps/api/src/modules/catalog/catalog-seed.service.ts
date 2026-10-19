import { Injectable } from '@nestjs/common';
import type { CreateTaxClass, TaxClassDto } from '@pos/contracts';
import type { TenantUnitOfWork } from '@pos/db';

import { DEFAULT_CONVERSIONS, DEFAULT_UNITS, UnitsService } from './units/units.service.js';
import { TaxClassesService } from './tax-classes/tax-classes.service.js';

/** Per-tenant catalog baseline created at provisioning: units of measure and their generic conversions. */
@Injectable()
export class CatalogSeedService {
  constructor(
    private readonly units: UnitsService,
    private readonly taxClasses: TaxClassesService,
  ) {}

  async seedUnits(uow: TenantUnitOfWork): Promise<void> {
    for (const unit of DEFAULT_UNITS) await this.units.insertRaw(uow, unit);
    for (const conversion of DEFAULT_CONVERSIONS)
      await this.units.insertConversionRaw(uow, conversion);
  }

  async seedTaxClasses(
    uow: TenantUnitOfWork,
    classes: readonly CreateTaxClass[],
  ): Promise<TaxClassDto[]> {
    const created: TaxClassDto[] = [];
    for (const c of classes) created.push(await this.taxClasses.insertRaw(uow, c));
    return created;
  }
}
