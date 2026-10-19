import type {
  ChargeKind,
  DiscountKind,
  ItemSnapshot,
  LineTax,
  OrderLine,
  OrderState,
  PricingMode,
} from './types.js';

/**
 * Ports the order engine depends on. They are declared here so S-F4 compiles without importing
 * S-F2 (catalog) or S-F3 (price engine) code; the integration slice replaces the stubs below
 * (`StubPricingPort`, `StubCatalogPort`) with adapters over the real engines.
 */

// ---------------------------------------------------------------------------
// PricingPort (consumed from S-F3). Synchronous and pure, like priceOrder().
// ---------------------------------------------------------------------------

export interface PricingDiscountRequest {
  readonly id: string;
  readonly kind: DiscountKind;
  /** null = order-level. */
  readonly lineId: string | null;
  /** Percentage points ("12.5") or null for a fixed amount. */
  readonly percent: string | null;
  /** Fixed amount; ignored when `percent` is set. */
  readonly amountMinor: bigint;
}

export interface PricingLineRequest {
  readonly id: string;
  /** numeric(14,4) text. */
  readonly quantity: string;
  /** Charged unit price including modifier deltas. */
  readonly unitPriceMinor: bigint;
  /**
   * When set, the line's gross is this amount instead of quantity × unit price: shared-item
   * portions (parts must add up to the original) and return lines (they refund what was paid).
   * Integration requirement for S-F3's adapter.
   */
  readonly grossOverrideMinor: bigint | null;
  readonly variantId: string | null;
  readonly taxClassCode: string | null;
}

export interface PricingChargeRequest {
  readonly id: string;
  readonly kind: ChargeKind;
  readonly amountMinor: bigint;
  /** Percentage points of the net of `appliesToLineIds`; takes precedence over `amountMinor`. */
  readonly percent: string | null;
  readonly taxable: boolean;
  /** The priced lines of the charge's check: a percent charge never reaches into other checks. */
  readonly appliesToLineIds: readonly string[];
}

export interface PricingRequest {
  readonly currency: string;
  readonly pricingMode: PricingMode;
  readonly locationId: string;
  readonly customerId: string | null;
  readonly priceListId: string | null;
  /** ISO instant the sale is priced at. */
  readonly at: string;
  readonly businessDate: string;
  readonly lines: readonly PricingLineRequest[];
  readonly discounts: readonly PricingDiscountRequest[];
  readonly charges: readonly PricingChargeRequest[];
}

export interface PricedLine {
  readonly id: string;
  readonly grossMinor: bigint;
  /** Σ line discounts + allocated order discounts. */
  readonly discountMinor: bigint;
  /** gross − discount. For tax-inclusive pricing this contains the tax. */
  readonly netMinor: bigint;
  readonly taxMinor: bigint;
  /** net, plus tax when exclusive. */
  readonly totalMinor: bigint;
  readonly taxes: readonly LineTax[];
}

export interface PricedDiscount {
  readonly id: string;
  /** What the discount resolved to (a percent becomes an amount). */
  readonly amountMinor: bigint;
  readonly trace?: unknown;
}

export interface PricedCharge {
  readonly id: string;
  readonly amountMinor: bigint;
  readonly taxMinor: bigint;
}

export interface PricedOrder {
  readonly lines: readonly PricedLine[];
  readonly discounts: readonly PricedDiscount[];
  readonly charges: readonly PricedCharge[];
  /** Ordered explanation (receipts, audit, tests). */
  readonly trace: readonly {
    readonly step: string;
    readonly ref: string;
    readonly amountMinor: bigint;
    readonly detail?: string;
  }[];
}

export interface PricingPort {
  priceOrder(request: PricingRequest): PricedOrder;
}

// ---------------------------------------------------------------------------
// CatalogPort (consumed from S-F2). Async: it reads the catalog.
// ---------------------------------------------------------------------------

/** What the client submitted for a line; the stub trusts it, the real catalog verifies it. */
export interface SubmittedLine {
  readonly variantId: string | null;
  readonly item: ItemSnapshot | null;
  readonly unitOfMeasure: string | null;
  readonly listPriceMinor: bigint | null;
}

export interface VariantSnapshot {
  readonly variantId: string | null;
  readonly itemSnapshot: ItemSnapshot;
  readonly unitOfMeasure: string;
  /** Resolved base price before overrides and discounts. */
  readonly listPriceMinor: bigint;
}

export interface CatalogLookupContext {
  readonly tenantId: string;
  readonly locationId: string;
  readonly channel: string;
  readonly at: string;
}

export interface CatalogPort {
  /** Resolve a submitted line to the facts the order stores. Throws a domain error when the variant is unknown. */
  resolveVariant(context: CatalogLookupContext, line: SubmittedLine): Promise<VariantSnapshot>;
}

// ---------------------------------------------------------------------------
// OrderPort (provided to S-F5 payments). Methods run inside the caller's transaction (`Tx`).
// ---------------------------------------------------------------------------

export interface CheckTotalsView {
  readonly checkId: string;
  readonly number: number;
  readonly status: string;
  readonly totalMinor: bigint;
  readonly paidMinor: bigint;
  readonly refundedMinor: bigint;
  /** total − paid; negative totals (returns) give negative amounts due. */
  readonly dueMinor: bigint;
}

export interface OrderTotalsView {
  readonly orderId: string;
  readonly version: number;
  readonly currency: string;
  readonly status: string;
  readonly paymentStatus: string;
  readonly totalMinor: bigint;
  readonly paidMinor: bigint;
  readonly refundedMinor: bigint;
  readonly dueMinor: bigint;
  readonly checks: readonly CheckTotalsView[];
}

export interface ApplyPaymentInput {
  readonly orderId: string;
  /** Default: the order's only open check. */
  readonly checkId?: string;
  /** Signed like the check's total: positive for sales, negative for refunds owed on returns. */
  readonly amountMinor: bigint;
  /** Gratuity included in `amountMinor`. */
  readonly tipMinor?: bigint;
  /** Cash rounding for this check (replaces the previous value). */
  readonly roundingMinor?: bigint;
  /** Payment engine reference (intent/attempt id); makes the call idempotent. */
  readonly paymentRef: string;
  readonly method?: string;
}

export interface ApplyRefundInput {
  readonly orderId: string;
  readonly checkId?: string;
  /** Positive amount handed back. */
  readonly amountMinor: bigint;
  readonly paymentRef: string;
  readonly reason?: string;
}

export interface MarkPaidInput {
  readonly orderId: string;
  /** Idempotency: the payment that settled the last check. */
  readonly paymentRef?: string;
}

export interface ReopenOfflineInput {
  readonly orderId: string;
  readonly checkId?: string;
  readonly reversedMinor: bigint;
  readonly reason: 'offline_payment_declined' | 'offline_payment_expired';
  readonly paymentRef?: string;
}

export interface OrderPort<Tx = unknown> {
  getTotals(tx: Tx, orderId: string): Promise<OrderTotalsView>;
  /** Record captured money against a check (closes the check when settled, updates paymentStatus). Idempotent per paymentRef. */
  applyPayment(tx: Tx, input: ApplyPaymentInput): Promise<OrderTotalsView>;
  /** Complete the order once every check is settled (emits order.completed). Throws ORDER_NOT_FULLY_PAID otherwise. */
  markPaid(tx: Tx, input: MarkPaidInput): Promise<OrderTotalsView>;
  /** Record money handed back against a completed order (partially_refunded / refunded). Idempotent per paymentRef. */
  applyRefund(tx: Tx, input: ApplyRefundInput): Promise<OrderTotalsView>;
  /** completed → open when an offline card payment was declined after forwarding. */
  reopenOffline(tx: Tx, input: ReopenOfflineInput): Promise<OrderTotalsView>;
}

export function totalsViewOf(order: OrderState): OrderTotalsView {
  return {
    orderId: order.id,
    version: order.version,
    currency: order.currency,
    status: order.status,
    paymentStatus: order.paymentStatus,
    totalMinor: order.totalMinor,
    paidMinor: order.paidMinor,
    refundedMinor: order.refundedMinor,
    dueMinor: order.totalMinor - order.paidMinor,
    checks: order.checks.map((c) => ({
      checkId: c.id,
      number: c.number,
      status: c.status,
      totalMinor: c.totalMinor,
      paidMinor: c.paidMinor,
      refundedMinor: c.refundedMinor,
      dueMinor: c.totalMinor - c.paidMinor,
    })),
  };
}

export type { OrderLine };
