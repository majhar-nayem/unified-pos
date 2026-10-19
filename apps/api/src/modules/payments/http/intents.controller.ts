import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  CancelIntentSchema,
  CaptureIntentSchema,
  CashTenderResultSchema,
  CashTenderSchema,
  CreatePaymentIntentSchema,
  CreateRefundSchema,
  ForwardOutcomeRequestSchema,
  OfflineCollectionSchema,
  PAYMENT_PERMISSIONS,
  PaymentAttemptSchema,
  PaymentEventSchema,
  PaymentIntentListQuerySchema,
  PaymentIntentPageSchema,
  PaymentIntentSchema,
  RefundSchema,
  ReverseIntentSchema,
  SubmitIntentSchema,
} from '@pos/contracts';
import { z } from 'zod';

import { Contract, ValidBody, ValidParams, ValidQuery } from '../../kernel/public/index.js';
import { ExecutionService } from '../execution.service.js';
import { IntentsService } from '../intents.service.js';
import { RefundsService } from '../refunds.service.js';

const uuid = z.string().uuid();
const TAGS = ['payments'] as const;
const INTENT = { intentId: 'deviceId' } as const; // see accounts.controller.ts
const params = z.object({ intentId: uuid });
const ANY_UUID = '00000000-0000-4000-8000-000000000001';
const LOCATION_SCOPE = {
  kind: 'dynamic',
  from: 'body',
  scopeKind: 'location',
  idField: 'locationId',
} as const;
const KEY = 'example-key-0001';

@Controller('payments')
export class IntentsController {
  constructor(
    private readonly intents: IntentsService,
    private readonly execution: ExecutionService,
    private readonly refunds: RefundsService,
  ) {}

  @Post('intents')
  @Contract({
    operationId: 'payments.intents.create',
    summary: 'Create a payment intent (nothing is sent to the provider until submit)',
    tags: TAGS,
    body: CreatePaymentIntentSchema,
    response: PaymentIntentSchema,
    permission: PAYMENT_PERMISSIONS.take,
    scope: LOCATION_SCOPE,
    examples: {
      body: {
        locationId: '$fixture:locationId',
        orderId: ANY_UUID,
        checkId: ANY_UUID,
        clientIntentId: KEY,
        method: 'card_present',
        amountMinor: '1000',
      },
    },
  })
  create(@ValidBody() body: z.infer<typeof CreatePaymentIntentSchema>) {
    return this.intents.create(body);
  }

  @Get('intents')
  @Contract({
    operationId: 'payments.intents.list',
    tags: TAGS,
    query: PaymentIntentListQuerySchema,
    response: PaymentIntentPageSchema,
    permission: PAYMENT_PERMISSIONS.view,
  })
  list(@ValidQuery() query: z.infer<typeof PaymentIntentListQuerySchema>) {
    return this.intents.list(query);
  }

  @Get('intents/:intentId')
  @Contract({
    operationId: 'payments.intents.get',
    tags: TAGS,
    params,
    response: PaymentIntentSchema,
    permission: PAYMENT_PERMISSIONS.view,
    scope: { kind: 'tenant' },
    examples: { params: INTENT },
  })
  get(@ValidParams() p: { intentId: string }) {
    return this.intents.get(p.intentId);
  }

  @Get('intents/:intentId/events')
  @Contract({
    operationId: 'payments.intents.events',
    summary: 'Append-only payment events: the audit of record for this intent',
    tags: TAGS,
    params,
    response: z.array(PaymentEventSchema),
    permission: PAYMENT_PERMISSIONS.view,
    scope: { kind: 'tenant' },
    examples: { params: INTENT },
  })
  events(@ValidParams() p: { intentId: string }) {
    return this.intents.events(p.intentId);
  }

  @Get('intents/:intentId/attempts')
  @Contract({
    operationId: 'payments.intents.attempts',
    tags: TAGS,
    params,
    response: z.array(PaymentAttemptSchema),
    permission: PAYMENT_PERMISSIONS.view,
    scope: { kind: 'tenant' },
    examples: { params: INTENT },
  })
  attempts(@ValidParams() p: { intentId: string }) {
    return this.intents.attempts(p.intentId);
  }

  @Post('intents/:intentId/submit')
  @HttpCode(200)
  @Contract({
    operationId: 'payments.intents.submit',
    summary: 'Send the intent to the provider or terminal; an unknown outcome becomes `uncertain`',
    tags: TAGS,
    params,
    body: SubmitIntentSchema,
    response: PaymentIntentSchema,
    status: 200,
    permission: PAYMENT_PERMISSIONS.take,
    scope: { kind: 'tenant' },
    examples: { params: INTENT, body: {} },
  })
  submit(
    @ValidParams() p: { intentId: string },
    @ValidBody() body: z.infer<typeof SubmitIntentSchema>,
  ) {
    return this.execution.submit(p.intentId, body);
  }

  @Post('intents/:intentId/capture')
  @HttpCode(200)
  @Contract({
    operationId: 'payments.intents.capture',
    tags: TAGS,
    params,
    body: CaptureIntentSchema,
    response: PaymentIntentSchema,
    status: 200,
    permission: PAYMENT_PERMISSIONS.manage,
    scope: { kind: 'tenant' },
    examples: { params: INTENT, body: {} },
  })
  capture(
    @ValidParams() p: { intentId: string },
    @ValidBody() body: z.infer<typeof CaptureIntentSchema>,
  ) {
    return this.execution.capture(p.intentId, body);
  }

  @Post('intents/:intentId/cancel')
  @HttpCode(200)
  @Contract({
    operationId: 'payments.intents.cancel',
    summary: 'Cancel before submit, or release an authorisation',
    tags: TAGS,
    params,
    body: CancelIntentSchema,
    response: PaymentIntentSchema,
    status: 200,
    permission: PAYMENT_PERMISSIONS.manage,
    scope: { kind: 'tenant' },
    examples: { params: INTENT, body: {} },
  })
  cancel(@ValidParams() p: { intentId: string }) {
    return this.execution.cancel(p.intentId);
  }

  @Post('intents/:intentId/reverse')
  @HttpCode(200)
  @Contract({
    operationId: 'payments.intents.reverse',
    summary: 'Same-batch void of a captured payment',
    tags: TAGS,
    params,
    body: ReverseIntentSchema,
    response: PaymentIntentSchema,
    status: 200,
    permission: PAYMENT_PERMISSIONS.manage,
    scope: { kind: 'tenant' },
    examples: { params: INTENT, body: {} },
  })
  reverse(@ValidParams() p: { intentId: string }) {
    return this.execution.reverse(p.intentId);
  }

  @Post('intents/:intentId/refunds')
  @Contract({
    operationId: 'payments.refunds.create',
    summary: 'Refund part or all of a captured payment',
    tags: TAGS,
    params,
    body: CreateRefundSchema,
    response: RefundSchema,
    permission: 'orders.refund.create',
    scope: { kind: 'tenant' },
    examples: {
      params: INTENT,
      body: { orderId: ANY_UUID, clientRefundId: 'example-refund-0001', amountMinor: '100' },
    },
  })
  refund(
    @ValidParams() p: { intentId: string },
    @ValidBody() body: z.infer<typeof CreateRefundSchema>,
  ) {
    return this.refunds.create(p.intentId, body);
  }

  @Get('intents/:intentId/refunds')
  @Contract({
    operationId: 'payments.refunds.list',
    tags: TAGS,
    params,
    response: z.array(RefundSchema),
    permission: PAYMENT_PERMISSIONS.view,
    scope: { kind: 'tenant' },
    examples: { params: INTENT },
  })
  listRefunds(@ValidParams() p: { intentId: string }) {
    return this.refunds.list(p.intentId);
  }

  @Post('intents/:intentId/forward-outcome')
  @HttpCode(200)
  @Contract({
    operationId: 'payments.intents.forward_outcome',
    summary: 'The Payments Edge reports the outcome of forwarding an offline-collected payment',
    tags: TAGS,
    params,
    body: ForwardOutcomeRequestSchema,
    response: PaymentIntentSchema,
    status: 200,
    permission: PAYMENT_PERMISSIONS.take,
    scope: { kind: 'tenant' },
    examples: { params: INTENT, body: { outcome: 'approved' } },
  })
  forwardOutcome(
    @ValidParams() p: { intentId: string },
    @ValidBody() body: z.infer<typeof ForwardOutcomeRequestSchema>,
  ) {
    return this.intents.recordForwardOutcome(p.intentId, body);
  }

  @Post('cash-tenders')
  @Contract({
    operationId: 'payments.cash_tenders.create',
    summary:
      'Take cash against a check: change and cash rounding are recorded on the intent and the order',
    tags: TAGS,
    body: CashTenderSchema,
    response: CashTenderResultSchema,
    permission: PAYMENT_PERMISSIONS.take,
    scope: LOCATION_SCOPE,
    examples: {
      body: {
        locationId: '$fixture:locationId',
        orderId: ANY_UUID,
        checkId: ANY_UUID,
        clientIntentId: KEY,
      },
    },
  })
  cash(@ValidBody() body: z.infer<typeof CashTenderSchema>) {
    return this.intents.cashTender(body);
  }

  @Post('offline-collections')
  @Contract({
    operationId: 'payments.offline_collections.create',
    summary: 'Record a card sale the terminal approved offline (store-and-forward)',
    tags: TAGS,
    body: OfflineCollectionSchema,
    response: PaymentIntentSchema,
    permission: PAYMENT_PERMISSIONS.take,
    scope: LOCATION_SCOPE,
    examples: {
      body: {
        locationId: '$fixture:locationId',
        orderId: ANY_UUID,
        checkId: ANY_UUID,
        clientIntentId: KEY,
        providerAccountId: ANY_UUID,
        terminalId: ANY_UUID,
        amountMinor: '1000',
        collectedAt: '2026-10-18T10:00:00.000Z',
      },
    },
  })
  offline(@ValidBody() body: z.infer<typeof OfflineCollectionSchema>) {
    return this.intents.recordOfflineCollection(body);
  }
}
