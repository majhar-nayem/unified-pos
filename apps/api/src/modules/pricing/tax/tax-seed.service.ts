import { Injectable } from '@nestjs/common';
import type { TenantUnitOfWork } from '@pos/db';

import { CatalogSeedService } from '../../catalog/public/index.js';
import { TaxRulesService } from './tax-rules.service.js';

/** Start of the Australian GST regime (A New Tax System (Goods and Services Tax) Act 1999). */
export const AU_GST_START = '2000-07-01';

/** Rates and classes are DATA: this table is the only place the AU seed names a number, and it lands in pricing.tax_rules. */
export const AU_TAX_SEED = [
  { code: 'standard', name: 'GST standard', rate: '0.100000', ruleName: 'GST 10%' },
  { code: 'gst_free', name: 'GST-free', rate: '0.000000', ruleName: 'GST-free (0%)' },
  { code: 'input_taxed', name: 'Input taxed', rate: '0.000000', ruleName: 'Input taxed (0%)' },
] as const;

/** Seeds the per-tenant AU GST baseline (docs/02 §2.2, schema_part3 reference seed). Runs inside provisioning. */
@Injectable()
export class TaxSeedService {
  constructor(
    private readonly catalogSeed: CatalogSeedService,
    private readonly rules: TaxRulesService,
  ) {}

  async seed(uow: TenantUnitOfWork): Promise<void> {
    const classes = await this.catalogSeed.seedTaxClasses(
      uow,
      AU_TAX_SEED.map(({ code, name }) => ({ code, name })),
    );
    for (const spec of AU_TAX_SEED) {
      const taxClass = classes.find((c) => c.code === spec.code)!;
      await this.rules.insertRaw(uow, {
        name: spec.ruleName,
        jurisdictionCountry: 'AU',
        taxClassId: taxClass.id,
        kind: 'vat_gst',
        rate: spec.rate,
        inclusiveDefault: true,
        priority: 100,
        validFrom: AU_GST_START,
      });
    }
  }
}
