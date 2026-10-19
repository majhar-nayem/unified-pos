import { Controller, Delete, Get, Header, HttpCode, Patch, Post, Res } from '@nestjs/common';
import {
  CatalogImportSchema,
  CreateCatalogImportSchema,
  CreateSupplierItemSchema,
  CreateSupplierSchema,
  CursorQuerySchema,
  SupplierItemSchema,
  SupplierListQuerySchema,
  SupplierPageSchema,
  SupplierSchema,
  UpdateSupplierItemSchema,
  UpdateSupplierSchema,
  pageOf,
} from '@pos/contracts';
import type { Response } from 'express';
import { z } from 'zod';

import { Contract, IfMatch, ValidBody, ValidParams, ValidQuery } from '../kernel/public/index.js';
import { TAGS, TENANT, fixtureParam, idParam } from './catalog.http.js';
import { CatalogImportService } from './import/import.service.js';
import { SuppliersService } from './suppliers/suppliers.service.js';

@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Get()
  @Contract({
    operationId: 'catalog.supplier.list',
    tags: TAGS,
    query: SupplierListQuerySchema,
    response: SupplierPageSchema,
    permission: 'catalog.view',
    scope: TENANT,
  })
  list(@ValidQuery() query: z.infer<typeof SupplierListQuerySchema>) {
    return this.suppliers.list(query);
  }

  @Post()
  @Contract({
    operationId: 'catalog.supplier.create',
    tags: TAGS,
    body: CreateSupplierSchema,
    response: SupplierSchema,
    permission: 'catalog.supplier.manage',
    scope: TENANT,
    idempotent: true,
    examples: {
      body: {
        code: 'ACME',
        name: 'Acme Wholesale',
        currency: 'AUD',
        leadTimeDays: 3,
        contacts: [{ name: 'Sam', email: 'sam@acme.test' }],
      },
    },
  })
  create(@ValidBody() body: z.infer<typeof CreateSupplierSchema>) {
    return this.suppliers.create(body);
  }

  @Get(':supplierId')
  @Contract({
    operationId: 'catalog.supplier.get',
    tags: TAGS,
    params: idParam('supplierId'),
    response: SupplierSchema,
    permission: 'catalog.view',
    scope: TENANT,
    examples: fixtureParam('supplierId'),
  })
  get(@ValidParams() params: { supplierId: string }) {
    return this.suppliers.get(params.supplierId);
  }

  @Patch(':supplierId')
  @Contract({
    operationId: 'catalog.supplier.update',
    tags: TAGS,
    params: idParam('supplierId'),
    body: UpdateSupplierSchema,
    response: SupplierSchema,
    permission: 'catalog.supplier.manage',
    scope: TENANT,
    concurrency: 'if-match',
    examples: { ...fixtureParam('supplierId'), body: { paymentTerms: 'Net 30' } },
  })
  update(
    @ValidParams() params: { supplierId: string },
    @ValidBody() body: z.infer<typeof UpdateSupplierSchema>,
    @IfMatch() version: number,
  ) {
    return this.suppliers.update(params.supplierId, body, version);
  }

  @Get(':supplierId/items')
  @Contract({
    operationId: 'catalog.supplier_item.list',
    tags: TAGS,
    params: idParam('supplierId'),
    response: z.array(SupplierItemSchema),
    permission: 'catalog.view',
    scope: TENANT,
    examples: fixtureParam('supplierId'),
  })
  listItems(@ValidParams() params: { supplierId: string }) {
    return this.suppliers.listItems(params.supplierId);
  }

  @Post(':supplierId/items')
  @Contract({
    operationId: 'catalog.supplier_item.create',
    tags: TAGS,
    params: idParam('supplierId'),
    body: CreateSupplierItemSchema,
    response: SupplierItemSchema,
    permission: 'catalog.supplier.manage',
    scope: TENANT,
    idempotent: true,
    examples: {
      ...fixtureParam('supplierId'),
      body: {
        variantId: '$fixture:childVariantId',
        supplierSku: 'AC-1',
        costMinor: '210',
        currency: 'AUD',
        packSize: '12',
      },
    },
  })
  createItem(
    @ValidParams() params: { supplierId: string },
    @ValidBody() body: z.infer<typeof CreateSupplierItemSchema>,
  ) {
    return this.suppliers.createItem(params.supplierId, body);
  }
}

@Controller('supplier-items')
export class SupplierItemsController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Patch(':supplierItemId')
  @Contract({
    operationId: 'catalog.supplier_item.update',
    tags: TAGS,
    params: idParam('supplierItemId'),
    body: UpdateSupplierItemSchema,
    response: SupplierItemSchema,
    permission: 'catalog.supplier.manage',
    scope: TENANT,
    examples: { ...fixtureParam('supplierItemId'), body: { isPreferred: true } },
  })
  update(
    @ValidParams() params: { supplierItemId: string },
    @ValidBody() body: z.infer<typeof UpdateSupplierItemSchema>,
  ) {
    return this.suppliers.updateItem(params.supplierItemId, body);
  }

  @Delete(':supplierItemId')
  @HttpCode(204)
  @Contract({
    operationId: 'catalog.supplier_item.delete',
    tags: TAGS,
    params: idParam('supplierItemId'),
    status: 204,
    permission: 'catalog.supplier.manage',
    scope: TENANT,
    examples: fixtureParam('supplierItemId'),
  })
  async delete(@ValidParams() params: { supplierItemId: string }): Promise<void> {
    await this.suppliers.deleteItem(params.supplierItemId);
  }
}

@Controller('catalog/imports')
export class CatalogImportController {
  constructor(private readonly imports: CatalogImportService) {}

  @Get()
  @Contract({
    operationId: 'catalog.import.list',
    tags: TAGS,
    query: CursorQuerySchema,
    response: pageOf(CatalogImportSchema),
    permission: 'catalog.import',
    scope: TENANT,
  })
  list(@ValidQuery() query: z.infer<typeof CursorQuerySchema>) {
    return this.imports.list(query);
  }

  @Post()
  @Contract({
    operationId: 'catalog.import.create',
    summary:
      'Validate and import items, variants and barcodes from CSV (all-or-nothing, create-only); returns the job with its validation report',
    tags: TAGS,
    body: CreateCatalogImportSchema,
    response: CatalogImportSchema,
    permission: 'catalog.import',
    scope: TENANT,
    idempotent: true,
    examples: {
      body: {
        fileName: 'harness.csv',
        dryRun: true,
        content: 'item_name,sku,price,barcode\r\nHarness import item,HI-1,4.50,9300000000031\r\n',
      },
    },
  })
  create(@ValidBody() body: z.infer<typeof CreateCatalogImportSchema>) {
    return this.imports.create(body);
  }

  @Get(':importId')
  @Contract({
    operationId: 'catalog.import.get',
    tags: TAGS,
    params: idParam('importId'),
    response: CatalogImportSchema,
    permission: 'catalog.import',
    scope: TENANT,
    examples: fixtureParam('importId'),
  })
  get(@ValidParams() params: { importId: string }) {
    return this.imports.get(params.importId);
  }

  @Get(':importId/report')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Contract({
    operationId: 'catalog.import.report',
    summary:
      'Downloadable validation report (CSV: line, column, code, message; empty when the file is valid)',
    tags: TAGS,
    params: idParam('importId'),
    response: z.string(),
    permission: 'catalog.import',
    scope: TENANT,
    examples: fixtureParam('importId'),
  })
  async report(
    @ValidParams() params: { importId: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const { csv, fileName } = await this.imports.report(params.importId);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return csv;
  }
}
