import { Controller, Delete, Get, Headers, HttpCode, Patch, Post } from '@nestjs/common';
import {
  AddChargeSchema,
  AddOrderLineSchema,
  ApplyDiscountSchema,
  CreateOrderSchema,
  CreateReturnSchema,
  ListOrdersQuerySchema,
  MergeChecksSchema,
  OrderEventSchema,
  OrderPageSchema,
  OrderSchema,
  PlaceOrderSchema,
  SplitChecksSchema,
  SuspendOrderSchema,
  UpdateOrderLineSchema,
  UpdateOrderSchema,
  VoidLineSchema,
  VoidOrderSchema,
} from '@pos/contracts';
import { z } from 'zod';

import { Contract, IfMatch, ValidBody, ValidParams, ValidQuery } from '../kernel/public/index.js';
import { OrdersService, type CommandOpts } from './orders.service.js';

const uuid = z.string().uuid();
const TAGS = ['orders'] as const;
const orderParams = z.object({ orderId: uuid });
const lineParams = z.object({ orderId: uuid, lineId: uuid });
const discountParams = z.object({ orderId: uuid, discountId: uuid });
const chargeParams = z.object({ orderId: uuid, chargeId: uuid });
const ORDER_ID = { orderId: 'orderId' } as const;

type Body<S extends z.ZodType> = z.infer<S>;
type Headers_ = Record<string, string | string[] | undefined>;

/** Idempotency-Key doubles as the client command id on order_events; If-Match is the version the client saw. */
function opts(headers: Headers_, version?: number): CommandOpts {
  const key = headers['idempotency-key'];
  return { version, commandId: typeof key === 'string' ? key : undefined };
}

/** Line adds commute, so If-Match is optional there: with it a stale client gets 412, without it adds serialise on the order lock. */
function optionalVersion(headers: Headers_): number | undefined {
  const raw = headers['if-match'];
  const match = typeof raw === 'string' ? /^(?:W\/)?"?(\d+)"?$/.exec(raw.trim()) : null;
  return match ? Number(match[1]) : undefined;
}

const command = (operationId: string, summary: string) => ({
  operationId,
  summary,
  tags: TAGS,
  response: OrderSchema,
  scope: { kind: 'tenant' } as const,
  idempotent: true,
  status: 200,
});

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @Contract({
    operationId: 'orders.order.create',
    summary:
      'Create a draft order (optionally with lines). Repeating a clientOrderRef returns the same order.',
    tags: TAGS,
    body: CreateOrderSchema,
    response: OrderSchema,
    permission: 'orders.create',
    scope: { kind: 'dynamic', from: 'body', scopeKind: 'location', idField: 'locationId' },
    idempotent: true,
    examples: { body: { locationId: '$fixture:locationId', kind: 'retail_sale' } },
  })
  create(@ValidBody() body: Body<typeof CreateOrderSchema>, @Headers() headers: Headers_) {
    return this.orders.create(body, opts(headers));
  }

  @Get()
  @Contract({
    operationId: 'orders.order.list',
    summary: 'Orders at a location, newest first',
    tags: TAGS,
    query: ListOrdersQuerySchema,
    response: OrderPageSchema,
    permission: 'orders.view',
    scope: { kind: 'dynamic', from: 'query', scopeKind: 'location', idField: 'locationId' },
    examples: { query: { locationId: '$fixture:locationId' } },
  })
  list(@ValidQuery() query: Body<typeof ListOrdersQuerySchema>) {
    return this.orders.list(query);
  }

  @Get(':orderId')
  @Contract({
    operationId: 'orders.order.get',
    tags: TAGS,
    params: orderParams,
    response: OrderSchema,
    permission: 'orders.view',
    scope: { kind: 'tenant' },
    examples: { params: ORDER_ID },
  })
  get(@ValidParams() params: { orderId: string }) {
    return this.orders.get(params.orderId);
  }

  @Get(':orderId/events')
  @Contract({
    operationId: 'orders.order.events',
    summary: 'The append-only order_events log',
    tags: TAGS,
    params: orderParams,
    response: z.array(OrderEventSchema),
    permission: 'orders.view',
    scope: { kind: 'tenant' },
    examples: { params: ORDER_ID },
  })
  events(@ValidParams() params: { orderId: string }) {
    return this.orders.events(params.orderId);
  }

  @Patch(':orderId')
  @Contract({
    operationId: 'orders.order.update',
    summary: 'Notes, guest count, customer, metadata',
    tags: TAGS,
    params: orderParams,
    body: UpdateOrderSchema,
    response: OrderSchema,
    permission: 'orders.create',
    scope: { kind: 'tenant' },
    concurrency: 'if-match',
    examples: { params: ORDER_ID, body: { notes: 'window seat' } },
  })
  update(
    @ValidParams() params: { orderId: string },
    @ValidBody() body: Body<typeof UpdateOrderSchema>,
    @IfMatch() version: number,
    @Headers() headers: Headers_,
  ) {
    return this.orders.update(params.orderId, body, opts(headers, version));
  }

  // ---- lines ---------------------------------------------------------------

  @Post(':orderId/lines')
  @HttpCode(200)
  @Contract({
    ...command(
      'orders.line.add',
      'Add a line. If-Match is optional: without it concurrent adds serialise on the order.',
    ),
    params: orderParams,
    body: AddOrderLineSchema,
    permission: 'orders.create',
    examples: {
      params: ORDER_ID,
      body: { item: { name: 'Flat white' }, listPriceMinor: '450', quantity: '1' },
    },
  })
  addLine(
    @ValidParams() params: { orderId: string },
    @ValidBody() body: Body<typeof AddOrderLineSchema>,
    @Headers() headers: Headers_,
  ) {
    return this.orders.addLine(params.orderId, body, opts(headers, optionalVersion(headers)));
  }

  @Patch(':orderId/lines/:lineId')
  @Contract({
    operationId: 'orders.line.update',
    tags: TAGS,
    params: lineParams,
    body: UpdateOrderLineSchema,
    response: OrderSchema,
    permission: 'orders.create',
    scope: { kind: 'tenant' },
    concurrency: 'if-match',
    examples: { params: { orderId: 'orderId', lineId: 'lineId' }, body: { quantity: '2' } },
  })
  updateLine(
    @ValidParams() params: { orderId: string; lineId: string },
    @ValidBody() body: Body<typeof UpdateOrderLineSchema>,
    @IfMatch() version: number,
    @Headers() headers: Headers_,
  ) {
    return this.orders.updateLine(params.orderId, params.lineId, body, opts(headers, version));
  }

  @Delete(':orderId/lines/:lineId')
  @Contract({
    operationId: 'orders.line.remove',
    summary: 'Remove a line from a draft order (a placed order voids it instead)',
    tags: TAGS,
    params: lineParams,
    response: OrderSchema,
    permission: 'orders.create',
    scope: { kind: 'tenant' },
    concurrency: 'if-match',
    examples: { params: { orderId: 'orderId', lineId: 'lineId' } },
  })
  removeLine(
    @ValidParams() params: { orderId: string; lineId: string },
    @IfMatch() version: number,
    @Headers() headers: Headers_,
  ) {
    return this.orders.removeLine(params.orderId, params.lineId, opts(headers, version));
  }

  @Post(':orderId/lines/:lineId/void')
  @HttpCode(200)
  @Contract({
    ...command(
      'orders.line.void',
      'Void a line of a placed order (orders.line.void or an approval)',
    ),
    params: lineParams,
    body: VoidLineSchema,
    permission: 'orders.line.void',
    concurrency: 'if-match',
    examples: {
      params: { orderId: 'orderId', lineId: 'lineId' },
      body: { reason: 'customer changed mind' },
    },
  })
  voidLine(
    @ValidParams() params: { orderId: string; lineId: string },
    @ValidBody() body: Body<typeof VoidLineSchema>,
    @IfMatch() version: number,
    @Headers() headers: Headers_,
  ) {
    return this.orders.voidLine(params.orderId, params.lineId, body, opts(headers, version));
  }

  // ---- discounts and charges ------------------------------------------------

  @Post(':orderId/discounts')
  @HttpCode(200)
  @Contract({
    ...command(
      'orders.discount.apply',
      'Apply a discount (over the caller’s limit needs an approval)',
    ),
    params: orderParams,
    body: ApplyDiscountSchema,
    permission: 'orders.discount.apply',
    concurrency: 'if-match',
    examples: { params: ORDER_ID, body: { description: 'Loyalty', percent: '5' } },
  })
  applyDiscount(
    @ValidParams() params: { orderId: string },
    @ValidBody() body: Body<typeof ApplyDiscountSchema>,
    @IfMatch() version: number,
    @Headers() headers: Headers_,
  ) {
    return this.orders.applyDiscount(params.orderId, body, opts(headers, version));
  }

  @Delete(':orderId/discounts/:discountId')
  @Contract({
    operationId: 'orders.discount.remove',
    tags: TAGS,
    params: discountParams,
    response: OrderSchema,
    permission: 'orders.discount.apply',
    scope: { kind: 'tenant' },
    concurrency: 'if-match',
    examples: { params: { orderId: 'orderId', discountId: 'discountId' } },
  })
  removeDiscount(
    @ValidParams() params: { orderId: string; discountId: string },
    @IfMatch() version: number,
    @Headers() headers: Headers_,
  ) {
    return this.orders.removeDiscount(params.orderId, params.discountId, opts(headers, version));
  }

  @Post(':orderId/charges')
  @HttpCode(200)
  @Contract({
    ...command('orders.charge.add', 'Add a service charge, surcharge or fee'),
    params: orderParams,
    body: AddChargeSchema,
    permission: 'orders.create',
    concurrency: 'if-match',
    examples: {
      params: ORDER_ID,
      body: { kind: 'surcharge', description: 'Public holiday', amountMinor: '100' },
    },
  })
  addCharge(
    @ValidParams() params: { orderId: string },
    @ValidBody() body: Body<typeof AddChargeSchema>,
    @IfMatch() version: number,
    @Headers() headers: Headers_,
  ) {
    return this.orders.addCharge(params.orderId, body, opts(headers, version));
  }

  @Delete(':orderId/charges/:chargeId')
  @Contract({
    operationId: 'orders.charge.remove',
    tags: TAGS,
    params: chargeParams,
    response: OrderSchema,
    permission: 'orders.create',
    scope: { kind: 'tenant' },
    concurrency: 'if-match',
    examples: { params: { orderId: 'orderId', chargeId: 'chargeId' } },
  })
  removeCharge(
    @ValidParams() params: { orderId: string; chargeId: string },
    @IfMatch() version: number,
    @Headers() headers: Headers_,
  ) {
    return this.orders.removeCharge(params.orderId, params.chargeId, opts(headers, version));
  }

  // ---- lifecycle -------------------------------------------------------------

  @Post(':orderId/suspend')
  @HttpCode(200)
  @Contract({
    ...command('orders.order.suspend', 'Suspend an open order'),
    params: orderParams,
    body: SuspendOrderSchema,
    permission: 'orders.create',
    concurrency: 'if-match',
    examples: { params: ORDER_ID, body: {} },
  })
  suspend(
    @ValidParams() params: { orderId: string },
    @ValidBody() body: Body<typeof SuspendOrderSchema>,
    @IfMatch() version: number,
    @Headers() headers: Headers_,
  ) {
    return this.orders.suspend(params.orderId, body, opts(headers, version));
  }

  @Post(':orderId/resume')
  @HttpCode(200)
  @Contract({
    ...command('orders.order.resume', 'Resume a suspended order'),
    params: orderParams,
    permission: 'orders.create',
    concurrency: 'if-match',
    examples: { params: ORDER_ID },
  })
  resume(
    @ValidParams() params: { orderId: string },
    @IfMatch() version: number,
    @Headers() headers: Headers_,
  ) {
    return this.orders.resume(params.orderId, opts(headers, version));
  }

  @Post(':orderId/place')
  @HttpCode(200)
  @Contract({
    ...command(
      'orders.order.place',
      'Place a draft: assigns the canonical order number and emits order.placed',
    ),
    params: orderParams,
    body: PlaceOrderSchema,
    permission: 'orders.create',
    concurrency: 'if-match',
    examples: { params: ORDER_ID, body: {} },
  })
  place(
    @ValidParams() params: { orderId: string },
    @ValidBody() body: Body<typeof PlaceOrderSchema>,
    @IfMatch() version: number,
    @Headers() headers: Headers_,
  ) {
    return this.orders.place(params.orderId, body, opts(headers, version));
  }

  @Post(':orderId/void')
  @HttpCode(200)
  @Contract({
    ...command(
      'orders.order.void',
      'Void or cancel an order (orders.void or an approval; discarding a draft needs only orders.create)',
    ),
    params: orderParams,
    body: VoidOrderSchema,
    permission: 'orders.void',
    concurrency: 'if-match',
    examples: { params: ORDER_ID, body: { reason: 'duplicate sale' } },
  })
  voidOrder(
    @ValidParams() params: { orderId: string },
    @ValidBody() body: Body<typeof VoidOrderSchema>,
    @IfMatch() version: number,
    @Headers() headers: Headers_,
  ) {
    return this.orders.voidOrder(params.orderId, body, opts(headers, version));
  }

  // ---- checks ----------------------------------------------------------------

  @Post(':orderId/checks/split')
  @HttpCode(200)
  @Contract({
    ...command('orders.check.split', 'Split by lines, by seats, or share one line across checks'),
    params: orderParams,
    body: SplitChecksSchema,
    permission: 'orders.create',
    concurrency: 'if-match',
    examples: {
      params: ORDER_ID,
      body: { mode: 'lines', fromCheckId: '$fixture:checkId', lineIds: ['$fixture:lineId'] },
    },
  })
  split(
    @ValidParams() params: { orderId: string },
    @ValidBody() body: Body<typeof SplitChecksSchema>,
    @IfMatch() version: number,
    @Headers() headers: Headers_,
  ) {
    return this.orders.splitChecks(params.orderId, body, opts(headers, version));
  }

  @Post(':orderId/checks/merge')
  @HttpCode(200)
  @Contract({
    ...command('orders.check.merge', 'Merge one check into another'),
    params: orderParams,
    body: MergeChecksSchema,
    permission: 'orders.create',
    concurrency: 'if-match',
    examples: {
      params: ORDER_ID,
      body: { sourceCheckId: '$fixture:otherCheckId', targetCheckId: '$fixture:checkId' },
    },
  })
  merge(
    @ValidParams() params: { orderId: string },
    @ValidBody() body: Body<typeof MergeChecksSchema>,
    @IfMatch() version: number,
    @Headers() headers: Headers_,
  ) {
    return this.orders.mergeChecks(params.orderId, body, opts(headers, version));
  }

  // ---- returns -----------------------------------------------------------------

  @Post(':orderId/returns')
  @Contract({
    operationId: 'orders.order.return',
    summary: 'Create a draft return or exchange against a completed order; place it to commit',
    tags: TAGS,
    params: orderParams,
    body: CreateReturnSchema,
    response: OrderSchema,
    permission: 'orders.refund.create',
    scope: { kind: 'tenant' },
    idempotent: true,
    examples: {
      params: ORDER_ID,
      body: { lines: [{ sourceLineId: '$fixture:lineId', quantity: '1' }] },
    },
  })
  createReturn(
    @ValidParams() params: { orderId: string },
    @ValidBody() body: Body<typeof CreateReturnSchema>,
    @Headers() headers: Headers_,
  ) {
    return this.orders.createReturn(params.orderId, body, opts(headers));
  }
}
