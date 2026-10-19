import { allocate } from '../money/allocate.js';
import { roundForCash } from '../money/cash-rounding.js';
import { type CurrencyRegistry, defaultCurrencies, normaliseCode } from '../money/currency.js';
import {
  type Decimal,
  decimalToString,
  divRound,
  mulDecimal,
  parseDecimal,
  pow10,
  type RoundingMode,
} from '../money/decimal.js';
import { toMinor } from '../money/money.js';
import type {
  ChargeInput,
  DiscountInput,
  PriceOrderInput,
  PriceOrderOutput,
  PricedCharge,
  PricedLine,
  TraceEntry,
} from './types.js';

export interface PriceOrderOptions {
  readonly currencies?: CurrencyRegistry;
}

/**
 * Deterministic pricing pipeline (docs/01-system-architecture.md §7.2).
 *
 * Implemented in Sprint 0: steps 2 (line discounts), 4 (order discount allocation, largest remainder),
 * 5 (tax per line, inclusive/exclusive), 6 (charges with their own tax), 7 (cash rounding) and 8 (trace).
 * Step 1 (price-list resolution) and step 3 (promotions) arrive in Phase 1 slice F3; callers pass the
 * resolved unit price for now.
 *
 * The same function runs on the server and inside the POS build; golden files are the contract.
 */
export function priceOrder(
  input: PriceOrderInput,
  options: PriceOrderOptions = {},
): PriceOrderOutput {
  const registry = options.currencies ?? defaultCurrencies;
  const currency = normaliseCode(input.currency);
  registry.get(currency); // throws UnknownCurrencyError early
  const mode: RoundingMode = input.roundingMode ?? 'HALF_UP';
  const trace: TraceEntry[] = [];

  // Step 1 (resolved upstream) + gross per line.
  const working = input.lines.map((line) => {
    const quantity = parseDecimal(line.quantity);
    if (quantity.unscaled < 0n)
      throw new RangeError(`Line ${line.id}: quantity must not be negative`);
    const unitPriceMinor = toMinor(line.unitPriceMinor);
    const grossMinor = mulDecimal(unitPriceMinor, quantity, mode);
    trace.push({ step: 'base_price', ref: line.id, amountMinor: grossMinor });
    return {
      line,
      quantity,
      unitPriceMinor,
      grossMinor,
      lineDiscountMinor: 0n,
      orderDiscountMinor: 0n,
    };
  });

  // Step 2: line-level manual discounts.
  for (const w of working) {
    if (!w.line.discount) continue;
    const discount = computeDiscount(w.line.discount, w.grossMinor, mode);
    w.lineDiscountMinor = discount;
    trace.push({
      step: 'line_discount',
      ref: w.line.id,
      amountMinor: -discount,
      detail: describeDiscount(w.line.discount),
    });
  }

  // Step 3: promotions — not yet implemented (Phase 1 F3).

  // Step 4: order-level discounts, allocated proportionally with the largest-remainder method.
  const orderDiscounts = input.orderDiscounts ?? [];
  if (orderDiscounts.length > 0) {
    const weights = working.map((w) => w.grossMinor - w.lineDiscountMinor);
    let remainingBase = weights.reduce((acc, w) => acc + w, 0n);
    const weightsForAllocation = weights.map((w) => (w < 0n ? 0n : w));
    for (const discount of orderDiscounts) {
      const amount = computeDiscount(discount, remainingBase, mode);
      trace.push({
        step: 'order_discount',
        ref: discount.id,
        amountMinor: -amount,
        detail: describeDiscount(discount),
      });
      const shares = allocate(amount, weightsForAllocation);
      shares.forEach((share, i) => {
        const w = working[i]!;
        w.orderDiscountMinor += share;
        trace.push({
          step: 'allocation',
          ref: w.line.id,
          amountMinor: -share,
          detail: discount.id,
        });
      });
      remainingBase -= amount;
    }
  }

  // Step 5: tax per line.
  const lines: PricedLine[] = working.map((w) => {
    const netMinor = w.grossMinor - w.lineDiscountMinor - w.orderDiscountMinor;
    const rate = parseDecimal(w.line.taxRate);
    const taxMinor = computeTax(netMinor, rate, w.line.taxInclusive, mode);
    trace.push({ step: 'tax', ref: w.line.id, amountMinor: taxMinor });
    return {
      id: w.line.id,
      quantity: decimalToString(w.quantity),
      unitPriceMinor: w.unitPriceMinor,
      grossMinor: w.grossMinor,
      lineDiscountMinor: w.lineDiscountMinor,
      orderDiscountMinor: w.orderDiscountMinor,
      netMinor,
      taxRate: decimalToString(rate),
      taxInclusive: w.line.taxInclusive,
      taxMinor,
      totalMinor: w.line.taxInclusive ? netMinor : netMinor + taxMinor,
    };
  });

  const subtotalMinor = sumBy(lines, (l) => l.grossMinor);
  const lineDiscountMinor = sumBy(lines, (l) => l.lineDiscountMinor);
  const orderDiscountMinor = sumBy(lines, (l) => l.orderDiscountMinor);
  const netMinor = sumBy(lines, (l) => l.netMinor);

  // Step 6: charges with their own tax treatment.
  const charges: PricedCharge[] = (input.charges ?? []).map((charge) => {
    const amountMinor = computeChargeAmount(charge, netMinor, mode);
    trace.push({ step: 'charge', ref: charge.id, amountMinor, detail: charge.kind });
    const taxMinor = computeTax(
      amountMinor,
      parseDecimal(charge.taxRate),
      charge.taxInclusive,
      mode,
    );
    trace.push({ step: 'tax', ref: charge.id, amountMinor: taxMinor });
    return {
      id: charge.id,
      kind: charge.kind,
      amountMinor,
      taxInclusive: charge.taxInclusive,
      taxMinor,
      totalMinor: charge.taxInclusive ? amountMinor : amountMinor + taxMinor,
    };
  });

  const taxMinor = sumBy(lines, (l) => l.taxMinor) + sumBy(charges, (c) => c.taxMinor);
  const chargesMinor = sumBy(charges, (c) => c.totalMinor);
  const totalMinor = sumBy(lines, (l) => l.totalMinor) + chargesMinor;

  // Step 7: cash rounding, only for cash tenders.
  let roundingMinor = 0n;
  if (input.tender?.method === 'cash') {
    const rounded = roundForCash({ amountMinor: totalMinor, currency }, registry);
    roundingMinor = rounded.roundingMinor;
    trace.push({ step: 'cash_rounding', ref: 'tender', amountMinor: roundingMinor });
  }

  // Step 8: output + ordered trace.
  return {
    currency,
    lines,
    charges,
    subtotalMinor,
    lineDiscountMinor,
    orderDiscountMinor,
    discountMinor: lineDiscountMinor + orderDiscountMinor,
    netMinor,
    taxMinor,
    chargesMinor,
    totalMinor,
    roundingMinor,
    amountDueMinor: totalMinor + roundingMinor,
    trace,
  };
}

/**
 * Tax on an amount. Inclusive: tax = amount × r / (1 + r). Exclusive: tax = amount × r.
 * Computed with exact rationals and rounded once.
 */
export function computeTax(
  amountMinor: bigint,
  rate: Decimal,
  inclusive: boolean,
  mode: RoundingMode,
): bigint {
  if (rate.unscaled < 0n) throw new RangeError('Tax rate must not be negative');
  if (rate.unscaled === 0n) return 0n;
  const scale = pow10(rate.scale);
  return inclusive
    ? divRound(amountMinor * rate.unscaled, scale + rate.unscaled, mode)
    : divRound(amountMinor * rate.unscaled, scale, mode);
}

function computeDiscount(discount: DiscountInput, baseMinor: bigint, mode: RoundingMode): bigint {
  let amount: bigint;
  if (discount.kind === 'percent') {
    const percent = parseDecimal(discount.value);
    if (percent.unscaled < 0n || percent.unscaled > 100n * pow10(percent.scale)) {
      throw new RangeError(`Discount ${discount.id}: percent must be between 0 and 100`);
    }
    amount = divRound(baseMinor * percent.unscaled, 100n * pow10(percent.scale), mode);
  } else {
    amount = toMinor(discount.value);
    if (amount < 0n) throw new RangeError(`Discount ${discount.id}: amount must not be negative`);
  }
  // A discount never exceeds what is left to discount.
  if (baseMinor <= 0n) return 0n;
  return amount > baseMinor ? baseMinor : amount;
}

function computeChargeAmount(
  charge: ChargeInput,
  linesNetMinor: bigint,
  mode: RoundingMode,
): bigint {
  if (charge.amountMinor !== undefined && charge.percent !== undefined) {
    throw new RangeError(`Charge ${charge.id}: specify either amountMinor or percent, not both`);
  }
  if (charge.amountMinor !== undefined) return toMinor(charge.amountMinor);
  if (charge.percent !== undefined) {
    const percent = parseDecimal(charge.percent);
    return divRound(linesNetMinor * percent.unscaled, 100n * pow10(percent.scale), mode);
  }
  throw new RangeError(`Charge ${charge.id}: amountMinor or percent is required`);
}

function describeDiscount(discount: DiscountInput): string {
  const base = discount.kind === 'percent' ? `${discount.value}%` : `${discount.value} minor`;
  return discount.authorizedBy ? `${base} authorized by ${discount.authorizedBy}` : base;
}

function sumBy<T>(items: readonly T[], pick: (item: T) => bigint): bigint {
  return items.reduce((acc, item) => acc + pick(item), 0n);
}
