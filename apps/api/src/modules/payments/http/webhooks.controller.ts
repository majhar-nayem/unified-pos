import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import {
  PAYMENT_PERMISSIONS,
  WebhookInboxPageSchema,
  WebhookInboxQuerySchema,
  WebhookParamsSchema,
  WebhookReceiptSchema,
} from '@pos/contracts';
import type { Request } from 'express';
import { z } from 'zod';

import { Contract, Public, ValidParams, ValidQuery } from '../../kernel/public/index.js';
import { WebhooksService } from '../webhooks.service.js';

const TAGS = ['payments'] as const;

type RawBodyRequest = Request & { rawBody?: Buffer };

@Controller('payments')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  /**
   * Provider webhook intake. Public: authenticity is the signature over the raw body with the
   * account's secret, not a bearer token. The deployable must be created with `rawBody: true`.
   */
  @Post('webhooks/:provider/:tenantId/:accountId')
  @Public()
  @HttpCode(200)
  @Contract({
    operationId: 'payments.webhooks.receive',
    summary: 'Provider webhook (signature verified, replay-safe)',
    tags: TAGS,
    params: WebhookParamsSchema,
    response: WebhookReceiptSchema,
    status: 200,
    public: true,
    // Public routes are skipped by the harness, but its completeness check still resolves these names.
    examples: { params: { provider: 'tenantId', tenantId: 'tenantId', accountId: 'deviceId' } },
  })
  receive(@ValidParams() params: z.infer<typeof WebhookParamsSchema>, @Req() req: RawBodyRequest) {
    if (!req.rawBody)
      throw new Error('Raw request body is unavailable: create the app with { rawBody: true }');
    return this.webhooks.receive({
      provider: params.provider,
      tenantId: params.tenantId,
      accountId: params.accountId,
      headers: req.headers,
      rawBody: req.rawBody,
      ip: req.ip,
    });
  }

  @Get('webhook-inbox')
  @Contract({
    operationId: 'payments.webhook_inbox.list',
    tags: TAGS,
    query: WebhookInboxQuerySchema,
    response: WebhookInboxPageSchema,
    permission: PAYMENT_PERMISSIONS.providerManage,
  })
  inbox(@ValidQuery() query: z.infer<typeof WebhookInboxQuerySchema>) {
    return this.webhooks.list(query);
  }
}
