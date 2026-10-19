import { Controller, Get } from '@nestjs/common';
import { Post } from '@nestjs/common';
import {
  CreateReceiptSchema,
  ReceiptRenderSchema,
  ReceiptSchema,
  RenderReceiptQuerySchema,
} from '@pos/contracts';
import { z } from 'zod';

import { Contract, ValidBody, ValidParams, ValidQuery } from '../kernel/public/index.js';
import { ReceiptsService } from './receipts.service.js';

const uuid = z.string().uuid();
const TAGS = ['receipts'] as const;
const orderParams = z.object({ orderId: uuid });
const receiptParams = z.object({ orderId: uuid, receiptId: uuid });

@Controller('orders/:orderId/receipts')
export class ReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  @Post()
  @Contract({
    operationId: 'orders.receipt.create',
    summary:
      'Issue a receipt (HTML, PDF, text, ESC/POS). Asking again for one already issued records a reprint.',
    tags: TAGS,
    params: orderParams,
    body: CreateReceiptSchema,
    response: ReceiptSchema,
    permission: 'orders.view',
    scope: { kind: 'tenant' },
    idempotent: true,
    examples: {
      params: { orderId: 'orderId' },
      body: { kind: 'proforma', deliveredVia: ['print'] },
    },
  })
  create(
    @ValidParams() params: { orderId: string },
    @ValidBody() body: z.infer<typeof CreateReceiptSchema>,
  ) {
    return this.receipts.create(params.orderId, body);
  }

  @Get()
  @Contract({
    operationId: 'orders.receipt.list',
    tags: TAGS,
    params: orderParams,
    response: z.array(ReceiptSchema),
    permission: 'orders.view',
    scope: { kind: 'tenant' },
    examples: { params: { orderId: 'orderId' } },
  })
  list(@ValidParams() params: { orderId: string }) {
    return this.receipts.list(params.orderId);
  }

  @Get(':receiptId')
  @Contract({
    operationId: 'orders.receipt.get',
    tags: TAGS,
    params: receiptParams,
    response: ReceiptSchema,
    permission: 'orders.view',
    scope: { kind: 'tenant' },
    examples: { params: { orderId: 'orderId', receiptId: 'receiptId' } },
  })
  get(@ValidParams() params: { orderId: string; receiptId: string }) {
    return this.receipts.get(params.orderId, params.receiptId);
  }

  @Get(':receiptId/render')
  @Contract({
    operationId: 'orders.receipt.render',
    summary: 'The stored content of a receipt: html, pdf (base64), text, escpos (base64)',
    tags: TAGS,
    params: receiptParams,
    query: RenderReceiptQuerySchema,
    response: ReceiptRenderSchema,
    permission: 'orders.view',
    scope: { kind: 'tenant' },
    examples: { params: { orderId: 'orderId', receiptId: 'receiptId' }, query: { format: 'html' } },
  })
  render(
    @ValidParams() params: { orderId: string; receiptId: string },
    @ValidQuery() query: z.infer<typeof RenderReceiptQuerySchema>,
  ) {
    return this.receipts.render(params.orderId, params.receiptId, query);
  }
}
