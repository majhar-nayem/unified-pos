import type { RoundingMode } from '../money/decimal.js';
import type { MinorAmountInput } from '../money/money.js';

/**
 * Inputs and outputs of the deterministic pricing pipeline (docs/01-system-architecture.md §7.2).
 *
 * All minor amounts accept bigint, number or integer string so the same shape works for JSON golden
 * files and for in-process callers. Quantities, rates and percentages are decimal strings.
 */

export type DiscountKind = 'percent' | 'amount';

export interface DiscountInput {
  readonly id: string;
  readonly kind: DiscountKind;
  /** Percentage points for `percent` ("12.5"); minor units for `amount`. */
  readonly value: string | number;
  /** Who authorised a manual discount; carried through to the trace. */
  readonly authorizedBy?: string;
}

export interface PricingLineInput {
  readonly id: string;
  /** Decimal quantity (numeric(14,4)); "1" for units, "1.2550" for weighed items. */
  readonly quantity: string | number;
  /** Resolved base unit price (step 1 of the pipeline happens upstream in Sprint 0). */
  readonly unitPriceMinor: MinorAmountInput;
  /** Tax rate as a decimal fraction ("0.10" for 10 % GST, "0" for GST-free). */
  readonly taxRate: string | number;
  /** true: unit price includes tax (AU default). false: tax is added on top. */
  readonly taxInclusive: boolean;
  readonly taxClass?: string;
  /** Line-level manual discount (step 2). */
  readonly discount?: DiscountInput;
}

export type ChargeKind = 'service_charge' | 'surcharge' | 'delivery_fee';

export interface ChargeInput {
  readonly id: string;
  readonly kind: ChargeKind;
  /** Fixed amount in minor units, or … */
  readonly amountMinor?: MinorAmountInput;
  /** … a percentage of the lines' net total (after all discounts). */
  readonly percent?: string | number;
  readonly taxRate: string | number;
  readonly taxInclusive: boolean;
}

export type TenderMethod = 'cash' | 'card' | 'other';

export interface PriceOrderInput {
  readonly currency: string;
  /** Rounding mode for tax and percentage arithmetic. Default HALF_UP. */
  readonly roundingMode?: RoundingMode;
  readonly lines: readonly PricingLineInput[];
  readonly orderDiscounts?: readonly DiscountInput[];
  readonly charges?: readonly ChargeInput[];
  /** Cash rounding applies only when the tender is cash. */
  readonly tender?: { readonly method: TenderMethod };
}

export type TraceStep =
  | 'base_price'
  | 'line_discount'
  | 'order_discount'
  | 'allocation'
  | 'tax'
  | 'charge'
  | 'cash_rounding';

export interface TraceEntry {
  readonly step: TraceStep;
  /** Line id, discount id, charge id, or "tender". */
  readonly ref: string;
  readonly amountMinor: bigint;
  readonly detail?: string;
}

export interface PricedLine {
  readonly id: string;
  readonly quantity: string;
  readonly unitPriceMinor: bigint;
  /** quantity × unit price, before any discount. */
  readonly grossMinor: bigint;
  readonly lineDiscountMinor: bigint;
  /** Share of order-level discounts allocated to this line (largest remainder). */
  readonly orderDiscountMinor: bigint;
  /** gross - lineDiscount - orderDiscount. For inclusive tax this already contains the tax. */
  readonly netMinor: bigint;
  readonly taxRate: string;
  readonly taxInclusive: boolean;
  readonly taxMinor: bigint;
  /** Amount the customer pays for this line: net (inclusive) or net + tax (exclusive). */
  readonly totalMinor: bigint;
}

export interface PricedCharge {
  readonly id: string;
  readonly kind: ChargeKind;
  readonly amountMinor: bigint;
  readonly taxInclusive: boolean;
  readonly taxMinor: bigint;
  readonly totalMinor: bigint;
}

export interface PriceOrderOutput {
  readonly currency: string;
  readonly lines: readonly PricedLine[];
  readonly charges: readonly PricedCharge[];
  /** Σ line gross. */
  readonly subtotalMinor: bigint;
  readonly lineDiscountMinor: bigint;
  readonly orderDiscountMinor: bigint;
  /** lineDiscount + orderDiscount. */
  readonly discountMinor: bigint;
  /** Σ line net. */
  readonly netMinor: bigint;
  /** Σ line tax + Σ charge tax. */
  readonly taxMinor: bigint;
  /** Σ charge total (charge amount plus any exclusive tax). */
  readonly chargesMinor: bigint;
  /** Σ line total + Σ charge total. What is owed before cash rounding. */
  readonly totalMinor: bigint;
  /** Cash rounding delta (0 unless the tender is cash and the currency rounds). */
  readonly roundingMinor: bigint;
  /** totalMinor + roundingMinor. */
  readonly amountDueMinor: bigint;
  readonly trace: readonly TraceEntry[];
}
