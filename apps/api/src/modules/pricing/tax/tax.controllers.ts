import { Controller, Delete, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  CreateTaxRuleSchema,
  TaxResolutionSchema,
  TaxResolveQuerySchema,
  TaxRuleListQuerySchema,
  TaxRulePageSchema,
  TaxRuleSchema,
  UpdateTaxRuleSchema,
} from '@pos/contracts';
import { z } from 'zod';

import {
  Contract,
  IfMatch,
  ValidBody,
  ValidParams,
  ValidQuery,
} from '../../kernel/public/index.js';
import { TaxRulesService } from './tax-rules.service.js';

const TAGS = ['pricing'] as const;
const TENANT = { kind: 'tenant' } as const;
const taxRuleParam = z.object({ taxRuleId: z.string().uuid() });
const example = { params: { taxRuleId: 'taxRuleId' } };

@Controller()
export class TaxController {
  constructor(private readonly rules: TaxRulesService) {}

  @Get('tax/resolve')
  @Contract({
    operationId: 'pricing.tax.resolve',
    summary:
      'Which tax rule applies to (country, region, tax class) on a date; effective rate and inclusive mode',
    tags: TAGS,
    query: TaxResolveQuerySchema,
    response: TaxResolutionSchema,
    permission: 'catalog.view',
    scope: TENANT,
    examples: { query: { country: 'AU', taxClassId: '$fixture:taxClassId', on: '2026-10-18' } },
  })
  resolve(@ValidQuery() query: z.infer<typeof TaxResolveQuerySchema>) {
    return this.rules.resolveForRequest(query);
  }

  @Get('tax-rules')
  @Contract({
    operationId: 'pricing.tax_rule.list',
    tags: TAGS,
    query: TaxRuleListQuerySchema,
    response: TaxRulePageSchema,
    permission: 'catalog.view',
    scope: TENANT,
  })
  list(@ValidQuery() query: z.infer<typeof TaxRuleListQuerySchema>) {
    return this.rules.list(query);
  }

  @Post('tax-rules')
  @Contract({
    operationId: 'pricing.tax_rule.create',
    tags: TAGS,
    body: CreateTaxRuleSchema,
    response: TaxRuleSchema,
    permission: 'pricing.tax.manage',
    scope: TENANT,
    idempotent: true,
    examples: {
      body: {
        name: 'Harness levy',
        jurisdictionCountry: 'AU',
        jurisdictionRegion: 'NSW',
        taxClassId: '$fixture:taxClassId',
        kind: 'levy',
        rate: '0.010000',
        priority: 10,
        validFrom: '2026-07-01',
      },
    },
  })
  create(@ValidBody() body: z.infer<typeof CreateTaxRuleSchema>) {
    return this.rules.create(body);
  }

  @Get('tax-rules/:taxRuleId')
  @Contract({
    operationId: 'pricing.tax_rule.get',
    tags: TAGS,
    params: taxRuleParam,
    response: TaxRuleSchema,
    permission: 'catalog.view',
    scope: TENANT,
    examples: example,
  })
  get(@ValidParams() params: { taxRuleId: string }) {
    return this.rules.get(params.taxRuleId);
  }

  @Patch('tax-rules/:taxRuleId')
  @Contract({
    operationId: 'pricing.tax_rule.update',
    tags: TAGS,
    params: taxRuleParam,
    body: UpdateTaxRuleSchema,
    response: TaxRuleSchema,
    permission: 'pricing.tax.manage',
    scope: TENANT,
    concurrency: 'if-match',
    examples: { ...example, body: { priority: 120 } },
  })
  update(
    @ValidParams() params: { taxRuleId: string },
    @ValidBody() body: z.infer<typeof UpdateTaxRuleSchema>,
    @IfMatch() version: number,
  ) {
    return this.rules.update(params.taxRuleId, body, version);
  }

  @Delete('tax-rules/:taxRuleId')
  @HttpCode(204)
  @Contract({
    operationId: 'pricing.tax_rule.delete',
    tags: TAGS,
    params: taxRuleParam,
    status: 204,
    permission: 'pricing.tax.manage',
    scope: TENANT,
    examples: example,
  })
  async delete(@ValidParams() params: { taxRuleId: string }): Promise<void> {
    await this.rules.delete(params.taxRuleId);
  }
}
