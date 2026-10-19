import { Controller, Delete, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  BulkPriceListEntriesSchema,
  CouponPageSchema,
  CouponListQuerySchema,
  CouponSchema,
  CreateCouponSchema,
  CreatePriceListAssignmentSchema,
  CreatePriceListEntrySchema,
  CreatePriceListSchema,
  CreatePromotionSchema,
  CreatePromotionScopeSchema,
  CursorQuerySchema,
  PriceListAssignmentPageSchema,
  PriceListAssignmentSchema,
  PriceListEntryListQuerySchema,
  PriceListEntryPageSchema,
  PriceListEntrySchema,
  PriceListListQuerySchema,
  PriceListPageSchema,
  PriceListSchema,
  PricedOrderSchema,
  PricingPreviewRequestSchema,
  PromotionListQuerySchema,
  PromotionPageSchema,
  PromotionSchema,
  PromotionScopePageSchema,
  PromotionScopeSchema,
  UpdateCouponSchema,
  UpdatePriceListAssignmentSchema,
  UpdatePriceListEntrySchema,
  UpdatePriceListSchema,
  UpdatePromotionSchema,
} from '@pos/contracts';
import { z } from 'zod';

import { Contract, IfMatch, ValidBody, ValidParams, ValidQuery } from '../kernel/public/index.js';
import { CouponsService } from './coupons.service.js';
import { PRICING_PERMISSIONS } from './permissions.js';
import { PriceListsService } from './price-lists.service.js';
import { PricingPreviewService } from './pricing-preview.service.js';
import { PromotionsService } from './promotions.service.js';

const TAGS = ['pricing'] as const;
const TENANT = { kind: 'tenant' } as const;
const uuid = z.string().uuid();
const idParam = (name: string) => z.object({ [name]: uuid });
const BulkResultSchema = z.object({
  priceListVersion: z.number().int().positive(),
  entries: z.array(PriceListEntrySchema),
});

type Params<K extends string> = Record<K, string>;
const { view, manage, preview } = PRICING_PERMISSIONS;

@Controller('price-lists')
export class PriceListsController {
  constructor(private readonly lists: PriceListsService) {}

  @Get()
  @Contract({
    operationId: 'pricing.price_list.list',
    tags: TAGS,
    query: PriceListListQuerySchema,
    response: PriceListPageSchema,
    permission: view,
    scope: TENANT,
  })
  list(@ValidQuery() query: z.infer<typeof PriceListListQuerySchema>) {
    return this.lists.list(query);
  }

  @Post()
  @Contract({
    operationId: 'pricing.price_list.create',
    tags: TAGS,
    body: CreatePriceListSchema,
    response: PriceListSchema,
    permission: manage,
    scope: TENANT,
    idempotent: true,
    examples: { body: { name: 'Members', currency: 'AUD', kind: 'member', priority: 50 } },
  })
  create(@ValidBody() body: z.infer<typeof CreatePriceListSchema>) {
    return this.lists.create(body);
  }

  @Get(':priceListId')
  @Contract({
    operationId: 'pricing.price_list.get',
    tags: TAGS,
    params: idParam('priceListId'),
    response: PriceListSchema,
    permission: view,
    scope: TENANT,
  })
  get(@ValidParams() params: Params<'priceListId'>) {
    return this.lists.get(params.priceListId);
  }

  @Patch(':priceListId')
  @Contract({
    operationId: 'pricing.price_list.update',
    tags: TAGS,
    params: idParam('priceListId'),
    body: UpdatePriceListSchema,
    response: PriceListSchema,
    permission: manage,
    scope: TENANT,
    concurrency: 'if-match',
    examples: { body: { name: 'Members (renamed)' } },
  })
  update(
    @ValidParams() params: Params<'priceListId'>,
    @ValidBody() body: z.infer<typeof UpdatePriceListSchema>,
    @IfMatch() version: number,
  ) {
    return this.lists.update(params.priceListId, body, version);
  }

  @Delete(':priceListId')
  @Contract({
    operationId: 'pricing.price_list.delete',
    summary: 'Delete a draft price list (anything else is archived instead)',
    tags: TAGS,
    params: idParam('priceListId'),
    response: PriceListSchema,
    permission: manage,
    scope: TENANT,
    concurrency: 'if-match',
    examples: { params: { priceListId: 'draftPriceListId' } },
  })
  remove(@ValidParams() params: Params<'priceListId'>, @IfMatch() version: number) {
    return this.lists.remove(params.priceListId, version);
  }

  // ---- entries

  @Get(':priceListId/entries')
  @Contract({
    operationId: 'pricing.price_list.entry.list',
    tags: TAGS,
    params: idParam('priceListId'),
    query: PriceListEntryListQuerySchema,
    response: PriceListEntryPageSchema,
    permission: view,
    scope: TENANT,
  })
  listEntries(
    @ValidParams() params: Params<'priceListId'>,
    @ValidQuery() query: z.infer<typeof PriceListEntryListQuerySchema>,
  ) {
    return this.lists.listEntries(params.priceListId, query);
  }

  @Post(':priceListId/entries')
  @Contract({
    operationId: 'pricing.price_list.entry.create',
    tags: TAGS,
    params: idParam('priceListId'),
    body: CreatePriceListEntrySchema,
    response: PriceListEntrySchema,
    permission: manage,
    scope: TENANT,
    idempotent: true,
    concurrency: 'if-match',
    examples: { body: { variantId: '$fixture:variantId', priceMinor: '995', minQuantity: '6' } },
  })
  createEntry(
    @ValidParams() params: Params<'priceListId'>,
    @ValidBody() body: z.infer<typeof CreatePriceListEntrySchema>,
    @IfMatch() version: number,
  ) {
    return this.lists.createEntry(params.priceListId, body, version);
  }

  @Post(':priceListId/entries/bulk')
  @HttpCode(200)
  @Contract({
    operationId: 'pricing.price_list.entry.upsert_bulk',
    summary: 'Upsert up to 1000 entries keyed by variant, minimum quantity and validFrom',
    tags: TAGS,
    params: idParam('priceListId'),
    body: BulkPriceListEntriesSchema,
    response: BulkResultSchema,
    status: 200,
    permission: manage,
    scope: TENANT,
    idempotent: true,
    concurrency: 'if-match',
    examples: { body: { entries: [{ variantId: '$fixture:variantId', priceMinor: '1050' }] } },
  })
  upsertEntries(
    @ValidParams() params: Params<'priceListId'>,
    @ValidBody() body: z.infer<typeof BulkPriceListEntriesSchema>,
    @IfMatch() version: number,
  ) {
    return this.lists.upsertEntries(params.priceListId, body, version);
  }

  @Patch(':priceListId/entries/:entryId')
  @Contract({
    operationId: 'pricing.price_list.entry.update',
    tags: TAGS,
    params: z.object({ priceListId: uuid, entryId: uuid }),
    body: UpdatePriceListEntrySchema,
    response: PriceListEntrySchema,
    permission: manage,
    scope: TENANT,
    concurrency: 'if-match',
    examples: { params: { entryId: 'priceListEntryId' }, body: { priceMinor: '1099' } },
  })
  updateEntry(
    @ValidParams() params: Params<'priceListId' | 'entryId'>,
    @ValidBody() body: z.infer<typeof UpdatePriceListEntrySchema>,
    @IfMatch() version: number,
  ) {
    return this.lists.updateEntry(params.priceListId, params.entryId, body, version);
  }

  @Delete(':priceListId/entries/:entryId')
  @Contract({
    operationId: 'pricing.price_list.entry.delete',
    tags: TAGS,
    params: z.object({ priceListId: uuid, entryId: uuid }),
    response: PriceListEntrySchema,
    permission: manage,
    scope: TENANT,
    concurrency: 'if-match',
    examples: { params: { entryId: 'priceListEntryId' } },
  })
  deleteEntry(
    @ValidParams() params: Params<'priceListId' | 'entryId'>,
    @IfMatch() version: number,
  ) {
    return this.lists.deleteEntry(params.priceListId, params.entryId, version);
  }

  // ---- assignments

  @Get(':priceListId/assignments')
  @Contract({
    operationId: 'pricing.price_list.assignment.list',
    tags: TAGS,
    params: idParam('priceListId'),
    query: CursorQuerySchema,
    response: PriceListAssignmentPageSchema,
    permission: view,
    scope: TENANT,
  })
  listAssignments(
    @ValidParams() params: Params<'priceListId'>,
    @ValidQuery() query: z.infer<typeof CursorQuerySchema>,
  ) {
    return this.lists.listAssignments(params.priceListId, query);
  }

  @Post(':priceListId/assignments')
  @Contract({
    operationId: 'pricing.price_list.assignment.create',
    tags: TAGS,
    params: idParam('priceListId'),
    body: CreatePriceListAssignmentSchema,
    response: PriceListAssignmentSchema,
    permission: manage,
    scope: TENANT,
    idempotent: true,
    concurrency: 'if-match',
    examples: { body: { scopeKind: 'location', scopeId: '$fixture:locationId', priority: 20 } },
  })
  createAssignment(
    @ValidParams() params: Params<'priceListId'>,
    @ValidBody() body: z.infer<typeof CreatePriceListAssignmentSchema>,
    @IfMatch() version: number,
  ) {
    return this.lists.createAssignment(params.priceListId, body, version);
  }

  @Patch(':priceListId/assignments/:assignmentId')
  @Contract({
    operationId: 'pricing.price_list.assignment.update',
    tags: TAGS,
    params: z.object({ priceListId: uuid, assignmentId: uuid }),
    body: UpdatePriceListAssignmentSchema,
    response: PriceListAssignmentSchema,
    permission: manage,
    scope: TENANT,
    concurrency: 'if-match',
    examples: { params: { assignmentId: 'priceListAssignmentId' }, body: { priority: 5 } },
  })
  updateAssignment(
    @ValidParams() params: Params<'priceListId' | 'assignmentId'>,
    @ValidBody() body: z.infer<typeof UpdatePriceListAssignmentSchema>,
    @IfMatch() version: number,
  ) {
    return this.lists.updateAssignment(params.priceListId, params.assignmentId, body, version);
  }

  @Delete(':priceListId/assignments/:assignmentId')
  @Contract({
    operationId: 'pricing.price_list.assignment.delete',
    tags: TAGS,
    params: z.object({ priceListId: uuid, assignmentId: uuid }),
    response: PriceListAssignmentSchema,
    permission: manage,
    scope: TENANT,
    concurrency: 'if-match',
    examples: { params: { assignmentId: 'priceListAssignmentId' } },
  })
  deleteAssignment(
    @ValidParams() params: Params<'priceListId' | 'assignmentId'>,
    @IfMatch() version: number,
  ) {
    return this.lists.deleteAssignment(params.priceListId, params.assignmentId, version);
  }
}

@Controller('promotions')
export class PromotionsController {
  constructor(
    private readonly promotions: PromotionsService,
    private readonly coupons: CouponsService,
  ) {}

  @Get()
  @Contract({
    operationId: 'pricing.promotion.list',
    tags: TAGS,
    query: PromotionListQuerySchema,
    response: PromotionPageSchema,
    permission: view,
    scope: TENANT,
  })
  list(@ValidQuery() query: z.infer<typeof PromotionListQuerySchema>) {
    return this.promotions.list(query);
  }

  @Post()
  @Contract({
    operationId: 'pricing.promotion.create',
    tags: TAGS,
    body: CreatePromotionSchema,
    response: PromotionSchema,
    permission: manage,
    scope: TENANT,
    idempotent: true,
    examples: {
      body: {
        name: 'Ten percent off drinks',
        kind: 'percent_off',
        rules: {
          version: 1,
          targets: { tags: ['drink'] },
          effect: { kind: 'percent_off', percent: '10' },
        },
        validFrom: '2026-10-01T00:00:00Z',
        scopes: [{ scopeKind: 'location', scopeId: '$fixture:locationId' }],
      },
    },
  })
  create(@ValidBody() body: z.infer<typeof CreatePromotionSchema>) {
    return this.promotions.create(body);
  }

  @Get(':promotionId')
  @Contract({
    operationId: 'pricing.promotion.get',
    tags: TAGS,
    params: idParam('promotionId'),
    response: PromotionSchema,
    permission: view,
    scope: TENANT,
  })
  get(@ValidParams() params: Params<'promotionId'>) {
    return this.promotions.get(params.promotionId);
  }

  @Patch(':promotionId')
  @Contract({
    operationId: 'pricing.promotion.update',
    tags: TAGS,
    params: idParam('promotionId'),
    body: UpdatePromotionSchema,
    response: PromotionSchema,
    permission: manage,
    scope: TENANT,
    concurrency: 'if-match',
    examples: { body: { name: 'Renamed promotion' } },
  })
  update(
    @ValidParams() params: Params<'promotionId'>,
    @ValidBody() body: z.infer<typeof UpdatePromotionSchema>,
    @IfMatch() version: number,
  ) {
    return this.promotions.update(params.promotionId, body, version);
  }

  @Delete(':promotionId')
  @Contract({
    operationId: 'pricing.promotion.delete',
    summary: 'Delete a draft promotion (anything else is archived instead)',
    tags: TAGS,
    params: idParam('promotionId'),
    response: PromotionSchema,
    permission: manage,
    scope: TENANT,
    concurrency: 'if-match',
    examples: { params: { promotionId: 'draftPromotionId' } },
  })
  remove(@ValidParams() params: Params<'promotionId'>, @IfMatch() version: number) {
    return this.promotions.remove(params.promotionId, version);
  }

  @Get(':promotionId/scopes')
  @Contract({
    operationId: 'pricing.promotion.scope.list',
    tags: TAGS,
    params: idParam('promotionId'),
    query: CursorQuerySchema,
    response: PromotionScopePageSchema,
    permission: view,
    scope: TENANT,
  })
  listScopes(
    @ValidParams() params: Params<'promotionId'>,
    @ValidQuery() query: z.infer<typeof CursorQuerySchema>,
  ) {
    return this.promotions.listScopes(params.promotionId, query);
  }

  @Post(':promotionId/scopes')
  @Contract({
    operationId: 'pricing.promotion.scope.create',
    tags: TAGS,
    params: idParam('promotionId'),
    body: CreatePromotionScopeSchema,
    response: PromotionScopeSchema,
    permission: manage,
    scope: TENANT,
    idempotent: true,
    concurrency: 'if-match',
    examples: { body: { scopeKind: 'channel', scopeValue: 'online' } },
  })
  createScope(
    @ValidParams() params: Params<'promotionId'>,
    @ValidBody() body: z.infer<typeof CreatePromotionScopeSchema>,
    @IfMatch() version: number,
  ) {
    return this.promotions.createScope(params.promotionId, body, version);
  }

  @Delete(':promotionId/scopes/:scopeId')
  @Contract({
    operationId: 'pricing.promotion.scope.delete',
    tags: TAGS,
    params: z.object({ promotionId: uuid, scopeId: uuid }),
    response: PromotionScopeSchema,
    permission: manage,
    scope: TENANT,
    concurrency: 'if-match',
    examples: { params: { scopeId: 'promotionScopeId' } },
  })
  deleteScope(
    @ValidParams() params: Params<'promotionId' | 'scopeId'>,
    @IfMatch() version: number,
  ) {
    return this.promotions.deleteScope(params.promotionId, params.scopeId, version);
  }

  @Post(':promotionId/coupons')
  @Contract({
    operationId: 'pricing.promotion.coupon.create',
    tags: TAGS,
    params: idParam('promotionId'),
    body: CreateCouponSchema,
    response: CouponSchema,
    permission: manage,
    scope: TENANT,
    idempotent: true,
    examples: { body: { code: 'SAVE10-HARNESS', maxUses: 5 } },
  })
  createCoupon(
    @ValidParams() params: Params<'promotionId'>,
    @ValidBody() body: z.infer<typeof CreateCouponSchema>,
  ) {
    return this.coupons.create(params.promotionId, body);
  }
}

@Controller('coupons')
export class CouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @Get()
  @Contract({
    operationId: 'pricing.coupon.list',
    tags: TAGS,
    query: CouponListQuerySchema,
    response: CouponPageSchema,
    permission: view,
    scope: TENANT,
  })
  list(@ValidQuery() query: z.infer<typeof CouponListQuerySchema>) {
    return this.coupons.list(query);
  }

  @Get(':couponId')
  @Contract({
    operationId: 'pricing.coupon.get',
    tags: TAGS,
    params: idParam('couponId'),
    response: CouponSchema,
    permission: view,
    scope: TENANT,
  })
  get(@ValidParams() params: Params<'couponId'>) {
    return this.coupons.get(params.couponId);
  }

  @Patch(':couponId')
  @Contract({
    operationId: 'pricing.coupon.update',
    summary: 'Change a coupon’s limits or void it (coupons have no version: guarded by status)',
    tags: TAGS,
    params: idParam('couponId'),
    body: UpdateCouponSchema,
    response: CouponSchema,
    permission: manage,
    scope: TENANT,
    examples: { body: { maxUses: 10 } },
  })
  update(
    @ValidParams() params: Params<'couponId'>,
    @ValidBody() body: z.infer<typeof UpdateCouponSchema>,
  ) {
    return this.coupons.update(params.couponId, body);
  }
}

@Controller('pricing')
export class PricingController {
  constructor(private readonly previews: PricingPreviewService) {}

  @Post('preview')
  @HttpCode(200)
  @Contract({
    operationId: 'pricing.preview',
    summary: 'Price an order draft with the same engine the POS runs',
    tags: TAGS,
    body: PricingPreviewRequestSchema,
    response: PricedOrderSchema,
    status: 200,
    permission: preview,
    scope: { kind: 'dynamic', from: 'body', scopeKind: 'location', idField: 'locationId' },
    examples: {
      body: {
        locationId: '$fixture:locationId',
        draft: {
          currency: 'AUD',
          lines: [
            {
              id: 'l1',
              variantId: '$fixture:variantId',
              quantity: '2',
              defaultUnitPriceMinor: '1100',
            },
          ],
        },
      },
    },
  })
  previewOrder(@ValidBody() body: z.infer<typeof PricingPreviewRequestSchema>) {
    return this.previews.preview(body);
  }
}
