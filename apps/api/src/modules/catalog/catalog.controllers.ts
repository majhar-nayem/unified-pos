import { Controller, Delete, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  BarcodeLookupQuerySchema,
  BarcodeSchema,
  CategoryListQuerySchema,
  CategoryPageSchema,
  CategorySchema,
  CreateBarcodeSchema,
  CreateCategorySchema,
  CreateItemComponentSchema,
  CreateItemSchema,
  CreateTaxClassSchema,
  CreateUnitConversionSchema,
  CreateUnitOfMeasureSchema,
  CreateVariantSchema,
  CursorQuerySchema,
  ItemComponentSchema,
  ItemDetailSchema,
  ItemListQuerySchema,
  ItemPageSchema,
  ItemSearchQuerySchema,
  ItemSearchResultSchema,
  RecipeSchema,
  SkuLookupQuerySchema,
  TaxClassPageSchema,
  TaxClassSchema,
  UnitConversionListQuerySchema,
  UnitConversionSchema,
  UnitCodeSchema,
  UnitOfMeasureSchema,
  UpdateCategorySchema,
  UpdateItemComponentSchema,
  UpdateItemSchema,
  UpdateTaxClassSchema,
  UpdateUnitOfMeasureSchema,
  UpdateVariantSchema,
  VariantLookupSchema,
  VariantWithBarcodesSchema,
  pageOf,
  type UnitConversionDto,
} from '@pos/contracts';
import { z } from 'zod';

import { Contract, IfMatch, ValidBody, ValidParams, ValidQuery } from '../kernel/public/index.js';
import { TAGS, TENANT, fixtureParam, idParam } from './catalog.http.js';
import { CategoriesService } from './categories/categories.service.js';
import { ComponentsService } from './items/components.service.js';
import { ItemsService } from './items/items.service.js';
import { TaxClassesService } from './tax-classes/tax-classes.service.js';
import { UnitsService } from './units/units.service.js';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @Contract({
    operationId: 'catalog.category.list',
    summary: 'Categories (materialised path order); `under` returns a subtree',
    tags: TAGS,
    query: CategoryListQuerySchema,
    response: CategoryPageSchema,
    permission: 'catalog.view',
    scope: TENANT,
  })
  list(@ValidQuery() query: z.infer<typeof CategoryListQuerySchema>) {
    return this.categories.list(query);
  }

  @Post()
  @Contract({
    operationId: 'catalog.category.create',
    tags: TAGS,
    body: CreateCategorySchema,
    response: CategorySchema,
    permission: 'catalog.item.manage',
    scope: TENANT,
    idempotent: true,
    examples: {
      body: {
        parentId: '$fixture:categoryId',
        kind: 'retail',
        code: 'new-cat',
        name: 'New category',
      },
    },
  })
  create(@ValidBody() body: z.infer<typeof CreateCategorySchema>) {
    return this.categories.create(body);
  }

  @Get(':categoryId')
  @Contract({
    operationId: 'catalog.category.get',
    tags: TAGS,
    params: idParam('categoryId'),
    response: CategorySchema,
    permission: 'catalog.view',
    scope: TENANT,
    examples: fixtureParam('categoryId'),
  })
  get(@ValidParams() params: { categoryId: string }) {
    return this.categories.get(params.categoryId);
  }

  @Patch(':categoryId')
  @Contract({
    operationId: 'catalog.category.update',
    tags: TAGS,
    params: idParam('categoryId'),
    body: UpdateCategorySchema,
    response: CategorySchema,
    permission: 'catalog.item.manage',
    scope: TENANT,
    concurrency: 'if-match',
    examples: { ...fixtureParam('categoryId'), body: { displayOrder: 5 } },
  })
  update(
    @ValidParams() params: { categoryId: string },
    @ValidBody() body: z.infer<typeof UpdateCategorySchema>,
    @IfMatch() version: number,
  ) {
    return this.categories.update(params.categoryId, body, version);
  }
}

@Controller('tax-classes')
export class TaxClassesController {
  constructor(private readonly taxClasses: TaxClassesService) {}

  @Get()
  @Contract({
    operationId: 'catalog.tax_class.list',
    tags: TAGS,
    query: CursorQuerySchema,
    response: TaxClassPageSchema,
    permission: 'catalog.view',
    scope: TENANT,
  })
  list(@ValidQuery() query: z.infer<typeof CursorQuerySchema>) {
    return this.taxClasses.list(query);
  }

  @Post()
  @Contract({
    operationId: 'catalog.tax_class.create',
    tags: TAGS,
    body: CreateTaxClassSchema,
    response: TaxClassSchema,
    permission: 'pricing.tax.manage',
    scope: TENANT,
    idempotent: true,
    examples: { body: { code: 'reduced', name: 'Reduced rate' } },
  })
  create(@ValidBody() body: z.infer<typeof CreateTaxClassSchema>) {
    return this.taxClasses.create(body);
  }

  @Get(':taxClassId')
  @Contract({
    operationId: 'catalog.tax_class.get',
    tags: TAGS,
    params: idParam('taxClassId'),
    response: TaxClassSchema,
    permission: 'catalog.view',
    scope: TENANT,
    examples: fixtureParam('taxClassId'),
  })
  get(@ValidParams() params: { taxClassId: string }) {
    return this.taxClasses.get(params.taxClassId);
  }

  @Patch(':taxClassId')
  @Contract({
    operationId: 'catalog.tax_class.update',
    tags: TAGS,
    params: idParam('taxClassId'),
    body: UpdateTaxClassSchema,
    response: TaxClassSchema,
    permission: 'pricing.tax.manage',
    scope: TENANT,
    concurrency: 'if-match',
    examples: { ...fixtureParam('taxClassId'), body: { name: 'Renamed class' } },
  })
  update(
    @ValidParams() params: { taxClassId: string },
    @ValidBody() body: z.infer<typeof UpdateTaxClassSchema>,
    @IfMatch() version: number,
  ) {
    return this.taxClasses.update(params.taxClassId, body, version);
  }
}

@Controller()
export class UnitsController {
  constructor(private readonly units: UnitsService) {}

  @Get('units')
  @Contract({
    operationId: 'catalog.unit.list',
    tags: TAGS,
    response: z.array(UnitOfMeasureSchema),
    permission: 'catalog.view',
    scope: TENANT,
  })
  list() {
    return this.units.list();
  }

  @Post('units')
  @Contract({
    operationId: 'catalog.unit.create',
    tags: TAGS,
    body: CreateUnitOfMeasureSchema,
    response: UnitOfMeasureSchema,
    permission: 'catalog.item.manage',
    scope: TENANT,
    idempotent: true,
    examples: { body: { code: 'case', name: 'Case', dimension: 'count' } },
  })
  create(@ValidBody() body: z.infer<typeof CreateUnitOfMeasureSchema>) {
    return this.units.create(body);
  }

  @Patch('units/:unitCode')
  @Contract({
    operationId: 'catalog.unit.update',
    tags: TAGS,
    params: z.object({ unitCode: UnitCodeSchema }),
    body: UpdateUnitOfMeasureSchema,
    response: UnitOfMeasureSchema,
    permission: 'catalog.item.manage',
    scope: TENANT,
    examples: { ...fixtureParam('unitCode'), body: { name: 'Renamed unit' } },
  })
  update(
    @ValidParams() params: { unitCode: string },
    @ValidBody() body: z.infer<typeof UpdateUnitOfMeasureSchema>,
  ) {
    return this.units.update(params.unitCode, body);
  }

  @Get('unit-conversions')
  @Contract({
    operationId: 'catalog.unit_conversion.list',
    tags: TAGS,
    query: UnitConversionListQuerySchema,
    response: pageOf(UnitConversionSchema),
    permission: 'catalog.view',
    scope: TENANT,
  })
  listConversions(@ValidQuery() query: z.infer<typeof UnitConversionListQuerySchema>) {
    return this.units.listConversions(query);
  }

  @Post('unit-conversions')
  @Contract({
    operationId: 'catalog.unit_conversion.create',
    tags: TAGS,
    body: CreateUnitConversionSchema,
    response: UnitConversionSchema,
    permission: 'catalog.item.manage',
    scope: TENANT,
    idempotent: true,
    examples: {
      body: { variantId: '$fixture:variantId', fromUnit: 'kg', toUnit: 'g', factor: '1000' },
    },
  })
  createConversion(
    @ValidBody() body: z.infer<typeof CreateUnitConversionSchema>,
  ): Promise<UnitConversionDto> {
    return this.units.createConversion(body);
  }

  @Delete('unit-conversions/:conversionId')
  @HttpCode(204)
  @Contract({
    operationId: 'catalog.unit_conversion.delete',
    tags: TAGS,
    params: idParam('conversionId'),
    status: 204,
    permission: 'catalog.item.manage',
    scope: TENANT,
    examples: fixtureParam('conversionId'),
  })
  async deleteConversion(@ValidParams() params: { conversionId: string }): Promise<void> {
    await this.units.deleteConversion(params.conversionId);
  }
}

@Controller('items')
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Get()
  @Contract({
    operationId: 'catalog.item.list',
    tags: TAGS,
    query: ItemListQuerySchema,
    response: ItemPageSchema,
    permission: 'catalog.view',
    scope: TENANT,
  })
  list(@ValidQuery() query: z.infer<typeof ItemListQuerySchema>) {
    return this.items.list(query);
  }

  @Post()
  @Contract({
    operationId: 'catalog.item.create',
    summary: 'Create an item, optionally with variants and barcodes',
    tags: TAGS,
    body: CreateItemSchema,
    response: ItemDetailSchema,
    permission: 'catalog.item.manage',
    scope: TENANT,
    idempotent: true,
    examples: {
      body: {
        kind: 'product',
        name: 'Harness test item',
        categoryId: '$fixture:categoryId',
        taxClassId: '$fixture:taxClassId',
        variants: [
          { sku: 'HARNESS-1', defaultPriceMinor: '450', barcodes: [{ code: '9300000000017' }] },
        ],
      },
    },
  })
  create(@ValidBody() body: z.infer<typeof CreateItemSchema>) {
    return this.items.create(body);
  }

  @Get('search')
  @Contract({
    operationId: 'catalog.item.search',
    summary:
      'Fuzzy product search: full text (name, SKU, barcode, description) plus trigram similarity for misspellings',
    tags: TAGS,
    query: ItemSearchQuerySchema,
    response: ItemSearchResultSchema,
    permission: 'catalog.view',
    scope: TENANT,
    examples: { query: { q: 'burger' } },
  })
  search(@ValidQuery() query: z.infer<typeof ItemSearchQuerySchema>) {
    return this.items.search(query);
  }

  @Get(':itemId')
  @Contract({
    operationId: 'catalog.item.get',
    tags: TAGS,
    params: idParam('itemId'),
    response: ItemDetailSchema,
    permission: 'catalog.view',
    scope: TENANT,
    examples: fixtureParam('itemId'),
  })
  get(@ValidParams() params: { itemId: string }) {
    return this.items.get(params.itemId);
  }

  @Patch(':itemId')
  @Contract({
    operationId: 'catalog.item.update',
    tags: TAGS,
    params: idParam('itemId'),
    body: UpdateItemSchema,
    response: ItemDetailSchema,
    permission: 'catalog.item.manage',
    scope: TENANT,
    concurrency: 'if-match',
    examples: { ...fixtureParam('itemId'), body: { shortName: 'Short' } },
  })
  update(
    @ValidParams() params: { itemId: string },
    @ValidBody() body: z.infer<typeof UpdateItemSchema>,
    @IfMatch() version: number,
  ) {
    return this.items.update(params.itemId, body, version);
  }

  @Get(':itemId/variants')
  @Contract({
    operationId: 'catalog.variant.list',
    tags: TAGS,
    params: idParam('itemId'),
    response: z.array(VariantWithBarcodesSchema),
    permission: 'catalog.view',
    scope: TENANT,
    examples: fixtureParam('itemId'),
  })
  listVariants(@ValidParams() params: { itemId: string }) {
    return this.items.listVariants(params.itemId);
  }

  @Post(':itemId/variants')
  @Contract({
    operationId: 'catalog.variant.create',
    tags: TAGS,
    params: idParam('itemId'),
    body: CreateVariantSchema,
    response: VariantWithBarcodesSchema,
    permission: 'catalog.item.manage',
    scope: TENANT,
    idempotent: true,
    examples: {
      ...fixtureParam('itemId'),
      body: { sku: 'HARNESS-V2', optionValues: { size: 'L' } },
    },
  })
  createVariant(
    @ValidParams() params: { itemId: string },
    @ValidBody() body: z.infer<typeof CreateVariantSchema>,
  ) {
    return this.items.createVariant(params.itemId, body);
  }
}

@Controller('variants')
export class VariantsController {
  constructor(
    private readonly items: ItemsService,
    private readonly components: ComponentsService,
  ) {}

  @Get('by-barcode')
  @Contract({
    operationId: 'catalog.variant.by_barcode',
    summary: 'Scan lookup (indexed on tenant + code)',
    tags: TAGS,
    query: BarcodeLookupQuerySchema,
    response: VariantLookupSchema,
    permission: 'catalog.view',
    scope: TENANT,
    examples: { query: { code: '0000000000000' } },
  })
  byBarcode(@ValidQuery() query: z.infer<typeof BarcodeLookupQuerySchema>) {
    return this.items.lookupByBarcode(query.code);
  }

  @Get('by-sku')
  @Contract({
    operationId: 'catalog.variant.by_sku',
    tags: TAGS,
    query: SkuLookupQuerySchema,
    response: VariantLookupSchema,
    permission: 'catalog.view',
    scope: TENANT,
    examples: { query: { sku: 'NO-SUCH-SKU' } },
  })
  bySku(@ValidQuery() query: z.infer<typeof SkuLookupQuerySchema>) {
    return this.items.lookupBySku(query.sku);
  }

  @Get(':variantId')
  @Contract({
    operationId: 'catalog.variant.get',
    tags: TAGS,
    params: idParam('variantId'),
    response: VariantWithBarcodesSchema,
    permission: 'catalog.view',
    scope: TENANT,
    examples: fixtureParam('variantId'),
  })
  get(@ValidParams() params: { variantId: string }) {
    return this.items.getVariant(params.variantId);
  }

  @Patch(':variantId')
  @Contract({
    operationId: 'catalog.variant.update',
    tags: TAGS,
    params: idParam('variantId'),
    body: UpdateVariantSchema,
    response: VariantWithBarcodesSchema,
    permission: 'catalog.item.manage',
    scope: TENANT,
    concurrency: 'if-match',
    examples: { ...fixtureParam('variantId'), body: { name: 'Renamed variant' } },
  })
  update(
    @ValidParams() params: { variantId: string },
    @ValidBody() body: z.infer<typeof UpdateVariantSchema>,
    @IfMatch() version: number,
  ) {
    return this.items.updateVariant(params.variantId, body, version);
  }

  @Post(':variantId/barcodes')
  @Contract({
    operationId: 'catalog.barcode.create',
    tags: TAGS,
    params: idParam('variantId'),
    body: CreateBarcodeSchema,
    response: BarcodeSchema,
    permission: 'catalog.item.manage',
    scope: TENANT,
    idempotent: true,
    examples: { ...fixtureParam('variantId'), body: { code: '9300000000024', kind: 'ean13' } },
  })
  addBarcode(
    @ValidParams() params: { variantId: string },
    @ValidBody() body: z.infer<typeof CreateBarcodeSchema>,
  ) {
    return this.items.addBarcode(params.variantId, body);
  }

  @Get(':variantId/components')
  @Contract({
    operationId: 'catalog.component.list',
    summary: 'Bundle / combo components of a parent variant',
    tags: TAGS,
    params: idParam('variantId'),
    response: z.array(ItemComponentSchema),
    permission: 'catalog.view',
    scope: TENANT,
    examples: fixtureParam('variantId'),
  })
  listComponents(@ValidParams() params: { variantId: string }) {
    return this.components.list(params.variantId);
  }

  @Post(':variantId/components')
  @Contract({
    operationId: 'catalog.component.create',
    tags: TAGS,
    params: idParam('variantId'),
    body: CreateItemComponentSchema,
    response: ItemComponentSchema,
    permission: 'catalog.item.manage',
    scope: TENANT,
    idempotent: true,
    examples: {
      ...fixtureParam('variantId'),
      body: { childVariantId: '$fixture:childVariantId', quantity: '2', componentGroup: 'side' },
    },
  })
  createComponent(
    @ValidParams() params: { variantId: string },
    @ValidBody() body: z.infer<typeof CreateItemComponentSchema>,
  ) {
    return this.components.create(params.variantId, body);
  }

  @Get(':variantId/recipes')
  @Contract({
    operationId: 'catalog.recipe.list',
    summary: 'Recipes of an output variant (read-only stub until M10)',
    tags: TAGS,
    params: idParam('variantId'),
    response: z.array(RecipeSchema),
    permission: 'catalog.view',
    scope: TENANT,
    examples: fixtureParam('variantId'),
  })
  listRecipes(@ValidParams() params: { variantId: string }) {
    return this.components.listRecipes(params.variantId);
  }
}

@Controller()
export class BarcodesAndComponentsController {
  constructor(
    private readonly items: ItemsService,
    private readonly components: ComponentsService,
  ) {}

  @Delete('barcodes/:barcodeId')
  @HttpCode(204)
  @Contract({
    operationId: 'catalog.barcode.delete',
    tags: TAGS,
    params: idParam('barcodeId'),
    status: 204,
    permission: 'catalog.item.manage',
    scope: TENANT,
    examples: fixtureParam('barcodeId'),
  })
  async deleteBarcode(@ValidParams() params: { barcodeId: string }): Promise<void> {
    await this.items.deleteBarcode(params.barcodeId);
  }

  @Patch('item-components/:componentId')
  @Contract({
    operationId: 'catalog.component.update',
    tags: TAGS,
    params: idParam('componentId'),
    body: UpdateItemComponentSchema,
    response: ItemComponentSchema,
    permission: 'catalog.item.manage',
    scope: TENANT,
    examples: { ...fixtureParam('componentId'), body: { quantity: '3' } },
  })
  updateComponent(
    @ValidParams() params: { componentId: string },
    @ValidBody() body: z.infer<typeof UpdateItemComponentSchema>,
  ) {
    return this.components.update(params.componentId, body);
  }

  @Delete('item-components/:componentId')
  @HttpCode(204)
  @Contract({
    operationId: 'catalog.component.delete',
    tags: TAGS,
    params: idParam('componentId'),
    status: 204,
    permission: 'catalog.item.manage',
    scope: TENANT,
    examples: fixtureParam('componentId'),
  })
  async deleteComponent(@ValidParams() params: { componentId: string }): Promise<void> {
    await this.components.delete(params.componentId);
  }
}
