/**
 * Order aggregate types (docs/01-system-architecture.md §7.1, docs/02-database-design.md §3.6).
 *
 * One aggregate for retail and restaurant: an Order owns Checks (the billable unit), Lines,
 * Discounts and Charges. Money is bigint minor units, quantities are numeric(14,4) decimal strings
 * ("1.5000"), timestamps are ISO strings supplied by the caller, so every reducer is pure.
 */

export const ORDER_KINDS = [
  'retail_sale',
  'return',
  'exchange',
  'layby',
  'special_order',
  'dine_in',
  'takeaway',
  'pickup',
  'delivery',
  'counter',
  'drive_through',
  'online',
  'phone',
  'catering',
  'staff_meal',
] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];

/** Kinds whose lines reference lines of an earlier order. */
export const RETURN_KINDS = ['return', 'exchange'] as const satisfies readonly OrderKind[];
export function isReturnKind(kind: OrderKind): boolean {
  return (RETURN_KINDS as readonly string[]).includes(kind);
}

export const ORDER_CHANNELS = [
  'pos',
  'kiosk',
  'qr',
  'online',
  'marketplace',
  'delivery_platform',
  'phone',
  'api',
] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];

export const ORDER_STATUSES = [
  'draft',
  'open',
  'suspended',
  'completed',
  'cancelled',
  'voided',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const FULFILLMENT_STATUSES = [
  'unfulfilled',
  'in_preparation',
  'partially_ready',
  'ready',
  'fulfilled',
  'not_applicable',
] as const;
export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number];

export const PAYMENT_STATUSES = [
  'unpaid',
  'partially_paid',
  'paid',
  'partially_refunded',
  'refunded',
  'not_applicable',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PRICING_MODES = ['tax_inclusive', 'tax_exclusive'] as const;
export type PricingMode = (typeof PRICING_MODES)[number];

export const CHECK_STATUSES = ['open', 'closed', 'voided'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const LINE_STATUSES = ['active', 'voided', 'returned', 'cancelled'] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];

export const KITCHEN_STATUSES = [
  'not_sent',
  'held',
  'sent',
  'in_progress',
  'ready',
  'served',
  'cancelled',
] as const;
export type KitchenStatus = (typeof KITCHEN_STATUSES)[number];

export const FULFILLMENT_MODES = ['take', 'pickup', 'ship', 'deliver', 'dine_in'] as const;
export type FulfillmentMode = (typeof FULFILLMENT_MODES)[number];

export const DISCOUNT_KINDS = [
  'promotion',
  'manual',
  'coupon',
  'loyalty',
  'employee',
  'price_match',
  'markdown',
] as const;
export type DiscountKind = (typeof DISCOUNT_KINDS)[number];

export const CHARGE_KINDS = [
  'service_charge',
  'surcharge',
  'delivery_fee',
  'packaging_fee',
  'gratuity',
  'deposit',
  'other',
] as const;
export type ChargeKind = (typeof CHARGE_KINDS)[number];

export const REOPEN_REASONS = ['offline_payment_declined', 'offline_payment_expired'] as const;
export type ReopenReason = (typeof REOPEN_REASONS)[number];

/** Frozen copy of the catalog facts a line was sold under (orders.order_lines.item_snapshot). */
export interface ItemSnapshot {
  readonly itemId?: string | null;
  readonly name: string;
  readonly sku?: string | null;
  readonly kind?: string | null;
  readonly taxClassCode?: string | null;
  readonly categoryPath?: string | null;
}

export interface LineModifier {
  readonly id: string;
  readonly modifierId: string | null;
  readonly groupName: string | null;
  readonly name: string;
  readonly kind: string;
  readonly quantity: number;
  readonly priceDeltaMinor: bigint;
}

export interface LineTax {
  readonly taxRuleId: string | null;
  readonly taxName: string;
  /** Decimal fraction string, "0.100000" for 10 %. */
  readonly rate: string;
  /** Amount the tax applies to, excluding tax. */
  readonly taxableMinor: bigint;
  readonly taxMinor: bigint;
  readonly inclusive: boolean;
  readonly exemptReason: string | null;
}

export interface OrderLine {
  readonly id: string;
  readonly checkId: string;
  readonly seq: number;
  readonly parentLineId: string | null;
  readonly variantId: string | null;
  readonly itemSnapshot: ItemSnapshot;
  /** Canonical numeric(14,4) text. */
  readonly quantity: string;
  readonly unitOfMeasure: string;
  readonly listPriceMinor: bigint;
  /** Price charged per unit after any override, before modifiers and discounts. */
  readonly unitPriceMinor: bigint;
  readonly priceOverrideReason: string | null;
  readonly priceOverrideApprovalId: string | null;
  readonly modifiers: readonly LineModifier[];
  /** Σ line discounts + this line's share of order discounts. */
  readonly discountMinor: bigint;
  readonly taxMinor: bigint;
  /** gross − discount (+ tax when the order is tax-exclusive). */
  readonly totalMinor: bigint;
  readonly taxes: readonly LineTax[];
  readonly seatNumber: number | null;
  readonly courseNumber: number | null;
  readonly status: LineStatus;
  readonly voidReason: string | null;
  readonly voidedBy: string | null;
  readonly voidApprovalId: string | null;
  readonly voidedAt: string | null;
  readonly kitchenStatus: KitchenStatus | null;
  readonly fulfillmentMode: FulfillmentMode;
  readonly returnOfLineId: string | null;
  readonly returnedQuantity: string;
  readonly notes: string | null;
  /**
   * Gross for this line when it is not quantity × unit price: shared-item portions (so the parts
   * add up to the original exactly) and return lines (they refund what was paid). null = derive.
   */
  readonly grossOverrideMinor: bigint | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface Check {
  readonly id: string;
  readonly number: number;
  readonly label: string | null;
  readonly status: CheckStatus;
  readonly subtotalMinor: bigint;
  readonly discountMinor: bigint;
  readonly taxMinor: bigint;
  readonly chargesMinor: bigint;
  readonly tipMinor: bigint;
  readonly roundingMinor: bigint;
  readonly totalMinor: bigint;
  readonly paidMinor: bigint;
  readonly refundedMinor: bigint;
  readonly closedAt: string | null;
  readonly closedBy: string | null;
  readonly version: number;
}

export interface OrderDiscount {
  readonly id: string;
  /** null = order-level (allocated proportionally to lines). */
  readonly orderLineId: string | null;
  readonly kind: DiscountKind;
  readonly promotionId: string | null;
  readonly couponId: string | null;
  readonly description: string;
  /** Percentage points ("12.5"), or null for a fixed amount. */
  readonly percent: string | null;
  /** Fixed amount, or the amount the percent resolved to at the last pricing run. */
  readonly amountMinor: bigint;
  readonly approvalId: string | null;
  readonly appliedBy: string | null;
  readonly appliedAt: string;
  readonly trace: unknown;
}

export interface OrderCharge {
  readonly id: string;
  readonly checkId: string;
  readonly kind: ChargeKind;
  readonly description: string;
  /** Resolved amount (fixed, or percent of the order's net at the last pricing run). */
  readonly amountMinor: bigint;
  /** Percentage points of the lines' net, or null for a fixed amount. */
  readonly percent: string | null;
  readonly taxable: boolean;
  readonly taxMinor: bigint;
  readonly isGratuity: boolean;
}

export interface OrderState {
  readonly id: string;
  readonly tenantId: string;
  readonly locationId: string;
  readonly registerId: string | null;
  readonly deviceId: string | null;
  /** Canonical per location and business date, assigned on place. */
  readonly orderNumber: number | null;
  /** Register-local number from an offline device ("R1-000123"). */
  readonly clientOrderRef: string | null;
  readonly businessDate: string;
  readonly kind: OrderKind;
  readonly channel: OrderChannel;
  readonly status: OrderStatus;
  readonly fulfillmentStatus: FulfillmentStatus;
  readonly paymentStatus: PaymentStatus;
  readonly customerId: string | null;
  readonly tableSessionId: string | null;
  readonly guestCount: number | null;
  readonly employeeId: string | null;
  readonly currency: string;
  readonly pricingMode: PricingMode;
  readonly priceListId: string | null;
  readonly configVersion: number | null;
  readonly subtotalMinor: bigint;
  readonly discountMinor: bigint;
  readonly taxMinor: bigint;
  readonly chargesMinor: bigint;
  readonly tipMinor: bigint;
  readonly roundingMinor: bigint;
  readonly totalMinor: bigint;
  readonly paidMinor: bigint;
  readonly refundedMinor: bigint;
  readonly sourceOrderId: string | null;
  readonly externalRef: string | null;
  readonly scheduledFor: string | null;
  readonly notes: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly placedAt: string | null;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  readonly voidedAt: string | null;
  readonly voidReason: string | null;
  readonly voidApprovalId: string | null;
  readonly reopenedAt: string | null;
  readonly reopenedReason: ReopenReason | null;
  readonly clientCreatedAt: string | null;
  readonly syncedAt: string | null;
  readonly settlementPending: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly checks: readonly Check[];
  readonly lines: readonly OrderLine[];
  readonly discounts: readonly OrderDiscount[];
  readonly charges: readonly OrderCharge[];
}

/** One append-only order_events row produced by a reducer. */
export interface OrderEvent {
  readonly kind: string;
  readonly fromStatus?: OrderStatus | null;
  readonly toStatus?: OrderStatus | null;
  readonly approvalId?: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ReducerResult {
  readonly state: OrderState;
  readonly events: readonly OrderEvent[];
}

/** Failure of a business rule; the API maps `kind` to 404 / 409 / 422. */
export type OrderRuleErrorKind = 'not_found' | 'conflict' | 'invalid';

export class OrderRuleError extends Error {
  constructor(
    public readonly kind: OrderRuleErrorKind,
    public readonly code: string,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'OrderRuleError';
  }
}

export const ruleConflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new OrderRuleError('conflict', code, message, details);
export const ruleInvalid = (code: string, message: string, details?: Record<string, unknown>) =>
  new OrderRuleError('invalid', code, message, details);
export const ruleNotFound = (code: string, message: string, details?: Record<string, unknown>) =>
  new OrderRuleError('not_found', code, message, details);
