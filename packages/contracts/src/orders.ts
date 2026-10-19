/**
 * Order and receipt DTOs for Phase 1 F4 (docs/03-implementation-plan.md §5 F4). Enum values come
 * from @pos/domain-core's order aggregate, which mirrors the CHECK constraints in
 * db/schema_part2.sql (orders schema). Money is an integer string of minor units, quantities are
 * numeric(14,4) text; request quantities may omit trailing zeros, responses never do.
 */
import { orders } from '@pos/domain-core';
import { z } from 'zod';

import { CursorQuerySchema, MinorAmountSchema, isoInstant, pageOf, uuid } from './common.js';
import { CalendarDateSchema, CurrencyCodeSchema } from './tenancy.js';

const text = (max: number) => z.string().min(1).max(max);
const version = z.number().int().positive();

export const OrderKindSchema = z.enum(orders.ORDER_KINDS);
export const OrderSalesChannelSchema = z.enum(orders.ORDER_CHANNELS);
export const OrderStatusSchema = z.enum(orders.ORDER_STATUSES);
export const FulfillmentStatusSchema = z.enum(orders.FULFILLMENT_STATUSES);
export const PaymentStatusSchema = z.enum(orders.PAYMENT_STATUSES);
export const PricingModeSchema = z.enum(orders.PRICING_MODES);
export const CheckStatusSchema = z.enum(orders.CHECK_STATUSES);
export const LineStatusSchema = z.enum(orders.LINE_STATUSES);
export const KitchenStatusSchema = z.enum(orders.KITCHEN_STATUSES);
export const FulfillmentModeSchema = z.enum(orders.FULFILLMENT_MODES);
export const DiscountKindSchema = z.enum(orders.DISCOUNT_KINDS);
export const ChargeKindSchema = z.enum(orders.CHARGE_KINDS);
export const ReceiptKindSchema = z.enum(orders.RECEIPT_KINDS);
export const ReopenReasonSchema = z.enum(orders.REOPEN_REASONS);

/** Kinds a client may create directly; return and exchange orders come from POST /orders/:id/returns. */
export const CREATABLE_ORDER_KINDS = orders.ORDER_KINDS.filter((k) => !orders.isReturnKind(k));

/** Domain events the orders module emits (the shared EVENT_CATALOG lists the first three; order.returned is new). */
export const ORDER_EVENT_NAMES = [
  'order.placed',
  'order.completed',
  'order.voided',
  'order.returned',
] as const;
export type OrderEventName = (typeof ORDER_EVENT_NAMES)[number];

/** Request quantity: greater than zero, at most 4 decimals. */
export const QuantityInputSchema = z
  .string()
  .regex(/^\d{1,10}(\.\d{1,4})?$/, 'decimal with at most 4 fractional digits')
  .refine((v) => Number(v) > 0, 'must be greater than zero');
export const QuantitySchema = z.string().regex(/^\d{1,10}\.\d{4}$/);
const NonNegativeMinorSchema = MinorAmountSchema.regex(/^\d+$/, 'non-negative integer string');

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

export const ItemSnapshotSchema = z.object({
  itemId: uuid.nullish(),
  name: text(200),
  sku: z.string().max(64).nullish(),
  kind: z.string().max(32).nullish(),
  taxClassCode: z.string().max(64).nullish(),
  categoryPath: z.string().max(500).nullish(),
});
export type ItemSnapshotDto = z.infer<typeof ItemSnapshotSchema>;

export const LineModifierInputSchema = z.object({
  modifierId: uuid.nullish(),
  groupName: z.string().max(200).nullish(),
  name: text(200),
  kind: z.string().min(1).max(32).optional(),
  quantity: z.number().int().min(1).max(32767).optional(),
  priceDeltaMinor: MinorAmountSchema.optional(),
});
export type LineModifierInput = z.infer<typeof LineModifierInputSchema>;

export const LineModifierSchema = z.object({
  id: uuid,
  modifierId: uuid.nullable(),
  groupName: z.string().nullable(),
  name: z.string(),
  kind: z.string(),
  quantity: z.number().int(),
  priceDeltaMinor: MinorAmountSchema,
});

export const OrderLineTaxSchema = z.object({
  taxRuleId: uuid.nullable(),
  taxName: z.string(),
  /** Decimal fraction, "0.100000" for 10 %. */
  rate: z.string(),
  taxableMinor: MinorAmountSchema,
  taxMinor: MinorAmountSchema,
  inclusive: z.boolean(),
  exemptReason: z.string().nullable(),
});

export const OrderLineSchema = z.object({
  id: uuid,
  checkId: uuid,
  seq: z.number().int().positive(),
  parentLineId: uuid.nullable(),
  variantId: uuid.nullable(),
  item: ItemSnapshotSchema,
  quantity: QuantitySchema,
  unitOfMeasure: z.string(),
  listPriceMinor: MinorAmountSchema,
  unitPriceMinor: MinorAmountSchema,
  priceOverrideReason: z.string().nullable(),
  priceOverrideApprovalId: uuid.nullable(),
  modifiers: z.array(LineModifierSchema),
  discountMinor: MinorAmountSchema,
  taxMinor: MinorAmountSchema,
  totalMinor: MinorAmountSchema,
  taxes: z.array(OrderLineTaxSchema),
  seatNumber: z.number().int().nullable(),
  courseNumber: z.number().int().nullable(),
  status: LineStatusSchema,
  voidReason: z.string().nullable(),
  voidedBy: uuid.nullable(),
  voidApprovalId: uuid.nullable(),
  voidedAt: isoInstant.nullable(),
  kitchenStatus: KitchenStatusSchema.nullable(),
  fulfillmentMode: FulfillmentModeSchema,
  returnOfLineId: uuid.nullable(),
  returnedQuantity: QuantitySchema,
  notes: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: isoInstant,
});
export type OrderLineDto = z.infer<typeof OrderLineSchema>;

/**
 * Add a line. With the stub catalog the client sends `item` and `listPriceMinor`; once S-F2's
 * catalog is wired, `variantId` alone resolves both and the submitted price is ignored.
 */
export const AddOrderLineSchema = z.object({
  variantId: uuid.nullish(),
  item: ItemSnapshotSchema.optional(),
  unitOfMeasure: z.string().min(1).max(32).optional(),
  listPriceMinor: NonNegativeMinorSchema.optional(),
  quantity: QuantityInputSchema,
  /** Price override: differing from the list price needs a reason (and orders.price.override). */
  unitPriceMinor: NonNegativeMinorSchema.optional(),
  priceOverrideReason: z.string().min(1).max(500).optional(),
  priceOverrideApprovalId: uuid.optional(),
  modifiers: z.array(LineModifierInputSchema).max(50).optional(),
  checkId: uuid.optional(),
  seatNumber: z.number().int().min(1).max(32767).nullish(),
  courseNumber: z.number().int().min(1).max(32767).nullish(),
  fulfillmentMode: FulfillmentModeSchema.optional(),
  kitchenStatus: KitchenStatusSchema.nullish(),
  notes: z.string().max(1000).nullish(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  parentLineId: uuid.optional(),
});
export type AddOrderLine = z.infer<typeof AddOrderLineSchema>;

export const UpdateOrderLineSchema = z
  .object({
    quantity: QuantityInputSchema,
    unitPriceMinor: NonNegativeMinorSchema,
    priceOverrideReason: z.string().min(1).max(500).nullable(),
    priceOverrideApprovalId: uuid.nullable(),
    modifiers: z.array(LineModifierInputSchema).max(50),
    seatNumber: z.number().int().min(1).max(32767).nullable(),
    courseNumber: z.number().int().min(1).max(32767).nullable(),
    fulfillmentMode: FulfillmentModeSchema,
    notes: z.string().max(1000).nullable(),
  })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'at least one field to change');
export type UpdateOrderLine = z.infer<typeof UpdateOrderLineSchema>;

export const VoidLineSchema = z.object({
  reason: text(500),
  /** An approved approval request (kind `void`) when the caller lacks orders.line.void. */
  approvalId: uuid.optional(),
});
export type VoidLine = z.infer<typeof VoidLineSchema>;

// ---------------------------------------------------------------------------
// Checks, discounts, charges, order
// ---------------------------------------------------------------------------

export const CheckSchema = z.object({
  id: uuid,
  number: z.number().int().positive(),
  label: z.string().nullable(),
  status: CheckStatusSchema,
  subtotalMinor: MinorAmountSchema,
  discountMinor: MinorAmountSchema,
  taxMinor: MinorAmountSchema,
  chargesMinor: MinorAmountSchema,
  tipMinor: MinorAmountSchema,
  roundingMinor: MinorAmountSchema,
  totalMinor: MinorAmountSchema,
  paidMinor: MinorAmountSchema,
  refundedMinor: MinorAmountSchema,
  closedAt: isoInstant.nullable(),
  closedBy: uuid.nullable(),
  version,
});
export type CheckDto = z.infer<typeof CheckSchema>;

export const OrderDiscountSchema = z.object({
  id: uuid,
  orderLineId: uuid.nullable(),
  kind: DiscountKindSchema,
  promotionId: uuid.nullable(),
  couponId: uuid.nullable(),
  description: z.string(),
  percent: z.string().nullable(),
  amountMinor: MinorAmountSchema,
  approvalId: uuid.nullable(),
  appliedBy: uuid.nullable(),
  appliedAt: isoInstant,
});
export type OrderDiscountDto = z.infer<typeof OrderDiscountSchema>;

export const OrderChargeSchema = z.object({
  id: uuid,
  checkId: uuid,
  kind: ChargeKindSchema,
  description: z.string(),
  amountMinor: MinorAmountSchema,
  percent: z.string().nullable(),
  taxable: z.boolean(),
  taxMinor: MinorAmountSchema,
  isGratuity: z.boolean(),
});
export type OrderChargeDto = z.infer<typeof OrderChargeSchema>;

export const OrderSchema = z.object({
  id: uuid,
  tenantId: uuid,
  locationId: uuid,
  registerId: uuid.nullable(),
  deviceId: uuid.nullable(),
  /** Canonical number per location and business date; null until the order is placed. */
  orderNumber: z.number().int().positive().nullable(),
  clientOrderRef: z.string().nullable(),
  businessDate: CalendarDateSchema,
  kind: OrderKindSchema,
  channel: OrderSalesChannelSchema,
  status: OrderStatusSchema,
  fulfillmentStatus: FulfillmentStatusSchema,
  paymentStatus: PaymentStatusSchema,
  customerId: uuid.nullable(),
  tableSessionId: uuid.nullable(),
  guestCount: z.number().int().nullable(),
  employeeId: uuid.nullable(),
  currency: CurrencyCodeSchema,
  pricingMode: PricingModeSchema,
  subtotalMinor: MinorAmountSchema,
  discountMinor: MinorAmountSchema,
  taxMinor: MinorAmountSchema,
  chargesMinor: MinorAmountSchema,
  tipMinor: MinorAmountSchema,
  roundingMinor: MinorAmountSchema,
  totalMinor: MinorAmountSchema,
  paidMinor: MinorAmountSchema,
  refundedMinor: MinorAmountSchema,
  sourceOrderId: uuid.nullable(),
  externalRef: z.string().nullable(),
  scheduledFor: isoInstant.nullable(),
  notes: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  placedAt: isoInstant.nullable(),
  completedAt: isoInstant.nullable(),
  cancelledAt: isoInstant.nullable(),
  voidedAt: isoInstant.nullable(),
  voidReason: z.string().nullable(),
  voidApprovalId: uuid.nullable(),
  reopenedAt: isoInstant.nullable(),
  reopenedReason: ReopenReasonSchema.nullable(),
  clientCreatedAt: isoInstant.nullable(),
  version,
  createdAt: isoInstant,
  updatedAt: isoInstant,
  checks: z.array(CheckSchema),
  lines: z.array(OrderLineSchema),
  discounts: z.array(OrderDiscountSchema),
  charges: z.array(OrderChargeSchema),
});
export type OrderDto = z.infer<typeof OrderSchema>;

export const OrderSummarySchema = z.object({
  id: uuid,
  locationId: uuid,
  orderNumber: z.number().int().positive().nullable(),
  clientOrderRef: z.string().nullable(),
  businessDate: CalendarDateSchema,
  kind: OrderKindSchema,
  status: OrderStatusSchema,
  fulfillmentStatus: FulfillmentStatusSchema,
  paymentStatus: PaymentStatusSchema,
  currency: CurrencyCodeSchema,
  totalMinor: MinorAmountSchema,
  paidMinor: MinorAmountSchema,
  version,
  createdAt: isoInstant,
});
export type OrderSummaryDto = z.infer<typeof OrderSummarySchema>;
export const OrderPageSchema = pageOf(OrderSummarySchema);
export type OrderPageDto = z.infer<typeof OrderPageSchema>;

export const OrderEventSchema = z.object({
  id: uuid,
  orderId: uuid,
  kind: z.string(),
  fromStatus: OrderStatusSchema.nullable(),
  toStatus: OrderStatusSchema.nullable(),
  actorUserId: uuid.nullable(),
  deviceId: uuid.nullable(),
  approvalId: uuid.nullable(),
  clientCommandId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  occurredAt: isoInstant,
  recordedAt: isoInstant,
});
export type OrderEventDto = z.infer<typeof OrderEventSchema>;

export const ListOrdersQuerySchema = CursorQuerySchema.extend({
  locationId: uuid,
  status: OrderStatusSchema.optional(),
  kind: OrderKindSchema.optional(),
  businessDate: CalendarDateSchema.optional(),
});
export type ListOrdersQuery = z.infer<typeof ListOrdersQuerySchema>;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const CreateOrderSchema = z.object({
  locationId: uuid,
  registerId: uuid.optional(),
  kind: z
    .enum(orders.ORDER_KINDS)
    .refine((k) => !orders.isReturnKind(k), 'create returns with POST /orders/{id}/returns')
    .default('retail_sale'),
  channel: OrderSalesChannelSchema.optional(),
  /** Default: the location's currency. */
  currency: CurrencyCodeSchema.optional(),
  pricingMode: PricingModeSchema.optional(),
  customerId: uuid.optional(),
  tableSessionId: uuid.optional(),
  guestCount: z.number().int().min(0).max(1000).optional(),
  employeeId: uuid.optional(),
  /** Register-local number from an offline device; creating twice with the same reference returns the same order. */
  clientOrderRef: z.string().min(1).max(64).optional(),
  /** Device clock for orders created offline; it fixes the business date. */
  clientCreatedAt: isoInstant.optional(),
  externalRef: z.string().min(1).max(200).optional(),
  scheduledFor: isoInstant.optional(),
  notes: z.string().max(2000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** Initial lines (cart sync); each is validated like POST /lines. */
  lines: z.array(AddOrderLineSchema).max(200).optional(),
});
export type CreateOrder = z.infer<typeof CreateOrderSchema>;

export const UpdateOrderSchema = z
  .object({
    notes: z.string().max(2000).nullable(),
    guestCount: z.number().int().min(0).max(1000).nullable(),
    customerId: uuid.nullable(),
    tableSessionId: uuid.nullable(),
    employeeId: uuid.nullable(),
    scheduledFor: isoInstant.nullable(),
    externalRef: z.string().min(1).max(200).nullable(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'at least one field to change');
export type UpdateOrder = z.infer<typeof UpdateOrderSchema>;

const oneOf = (a: string, b: string) => (v: Record<string, unknown>) =>
  (v[a] === undefined) !== (v[b] === undefined);

export const ApplyDiscountSchema = z
  .object({
    kind: DiscountKindSchema.optional(),
    /** Absent = order-level (allocated to lines). */
    lineId: uuid.optional(),
    /** Percentage points, up to 4 decimals: "12.5". */
    percent: z
      .string()
      .regex(/^\d{1,3}(\.\d{1,4})?$/)
      .optional(),
    amountMinor: NonNegativeMinorSchema.optional(),
    description: text(200),
    promotionId: uuid.optional(),
    couponId: uuid.optional(),
    /** An approved, unexpired approval request when the discount exceeds the caller's limit. */
    approvalId: uuid.optional(),
  })
  .refine(oneOf('percent', 'amountMinor'), 'give exactly one of percent or amountMinor');
export type ApplyDiscount = z.infer<typeof ApplyDiscountSchema>;

export const AddChargeSchema = z
  .object({
    kind: ChargeKindSchema,
    description: text(200),
    amountMinor: NonNegativeMinorSchema.optional(),
    percent: z
      .string()
      .regex(/^\d{1,3}(\.\d{1,4})?$/)
      .optional(),
    taxable: z.boolean().optional(),
    checkId: uuid.optional(),
  })
  .refine(oneOf('percent', 'amountMinor'), 'give exactly one of percent or amountMinor');
export type AddCharge = z.infer<typeof AddChargeSchema>;

export const SuspendOrderSchema = z.object({ reason: z.string().max(500).optional() }).default({});
export type SuspendOrder = z.infer<typeof SuspendOrderSchema>;

export const PlaceOrderSchema = z
  .object({
    /** Return orders: an approved approval request when the refund exceeds the caller's limit. */
    approvalId: uuid.optional(),
  })
  .default({});
export type PlaceOrder = z.infer<typeof PlaceOrderSchema>;

export const VoidOrderSchema = z.object({
  reason: text(500),
  /** An approved approval request (kind `void`, payload {permission: 'orders.void', orderId}) when the caller lacks orders.void. */
  approvalId: uuid.optional(),
});
export type VoidOrder = z.infer<typeof VoidOrderSchema>;

export const SplitChecksSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('lines'),
    fromCheckId: uuid,
    lineIds: z.array(uuid).min(1).max(200),
    toCheckId: uuid.optional(),
    label: z.string().max(100).optional(),
  }),
  z.object({
    mode: z.literal('seats'),
    fromCheckId: uuid,
    seatNumbers: z.array(z.number().int().min(1).max(32767)).min(1).max(50),
    toCheckId: uuid.optional(),
    label: z.string().max(100).optional(),
  }),
  z.object({
    mode: z.literal('share'),
    lineId: uuid,
    shares: z
      .array(
        z.object({
          checkId: uuid.optional(),
          label: z.string().max(100).optional(),
          quantity: QuantityInputSchema,
        }),
      )
      .min(2)
      .max(50)
      .optional(),
    parts: z.number().int().min(2).max(50).optional(),
    checkIds: z.array(uuid.nullable()).max(50).optional(),
  }),
]);
export type SplitChecks = z.infer<typeof SplitChecksSchema>;

export const MergeChecksSchema = z.object({ sourceCheckId: uuid, targetCheckId: uuid });
export type MergeChecks = z.infer<typeof MergeChecksSchema>;

export const CreateReturnSchema = z.object({
  kind: z.enum(['return', 'exchange']).default('return'),
  lines: z
    .array(
      z.object({
        sourceLineId: uuid,
        quantity: QuantityInputSchema,
        reason: z.string().max(500).optional(),
      }),
    )
    .min(1)
    .max(200),
  reason: z.string().max(500).optional(),
  registerId: uuid.optional(),
  clientOrderRef: z.string().min(1).max(64).optional(),
  clientCreatedAt: isoInstant.optional(),
  notes: z.string().max(2000).optional(),
});
export type CreateReturn = z.infer<typeof CreateReturnSchema>;

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export const RECEIPT_DELIVERY_CHANNELS = ['print', 'email', 'sms', 'qr'] as const;
export const ReceiptDeliverySchema = z.enum(RECEIPT_DELIVERY_CHANNELS);

export const ReceiptSchema = z.object({
  id: uuid,
  orderId: uuid,
  checkId: uuid.nullable(),
  number: z.string(),
  kind: ReceiptKindSchema,
  templateKey: z.string(),
  renderedUri: z.string().nullable(),
  deliveredVia: z.array(ReceiptDeliverySchema),
  printedBy: uuid.nullable(),
  deviceId: uuid.nullable(),
  createdAt: isoInstant,
});
export type ReceiptDto = z.infer<typeof ReceiptSchema>;

export const CreateReceiptSchema = z.object({
  /**
   * Default: `sale` for a completed order, `refund` for a return, `proforma` before completion.
   * Asking for a kind that was already issued for the same check records a `reprint` instead.
   */
  kind: z.enum(['sale', 'refund', 'gift', 'proforma', 'void']).optional(),
  checkId: uuid.optional(),
  templateKey: z.string().min(1).max(64).optional(),
  deliveredVia: z.array(ReceiptDeliverySchema).max(4).optional(),
});
export type CreateReceipt = z.infer<typeof CreateReceiptSchema>;

export const RECEIPT_FORMATS = ['html', 'pdf', 'escpos', 'text'] as const;
export const ReceiptFormatSchema = z.enum(RECEIPT_FORMATS);
export const RenderReceiptQuerySchema = z.object({
  format: ReceiptFormatSchema.default('html'),
  /** Paper width in characters for text and ESC/POS: 48 for 80 mm, 32 for 58 mm. */
  columns: z.coerce.number().int().min(24).max(64).optional(),
});
export type RenderReceiptQuery = z.infer<typeof RenderReceiptQuerySchema>;

export const ReceiptRenderSchema = z.object({
  receiptId: uuid,
  format: ReceiptFormatSchema,
  contentType: z.string(),
  /** html and text are UTF-8; pdf and escpos are base64. */
  encoding: z.enum(['utf8', 'base64']),
  content: z.string(),
});
export type ReceiptRenderDto = z.infer<typeof ReceiptRenderSchema>;
