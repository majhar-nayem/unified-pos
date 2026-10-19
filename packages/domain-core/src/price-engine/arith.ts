import { allocate } from '../money/allocate.js';
import {
  type Decimal,
  divRound,
  parseDecimal,
  pow10,
  type RoundingMode,
} from '../money/decimal.js';
import { type MinorAmountInput, toMinor } from '../money/money.js';
import type { DecimalInput } from './types.js';

/** Percentage points → amount, validated to [0, 100]. */
export function percentOf(
  amountMinor: bigint,
  percent: DecimalInput,
  mode: RoundingMode,
  label: string,
): bigint {
  const p = parseDecimal(percent);
  if (p.unscaled < 0n || p.unscaled > 100n * pow10(p.scale)) {
    throw new RangeError(`${label}: percent must be between 0 and 100`);
  }
  return divRound(amountMinor * p.unscaled, 100n * pow10(p.scale), mode);
}

export function nonNegativeMinor(value: MinorAmountInput, label: string): bigint {
  const amount = toMinor(value);
  if (amount < 0n) throw new RangeError(`${label}: amount must not be negative`);
  return amount;
}

export function parseQuantity(value: DecimalInput, label: string): Decimal {
  const quantity = parseDecimal(value);
  if (quantity.unscaled < 0n) throw new RangeError(`${label}: quantity must not be negative`);
  return quantity;
}

/** Whole units in a decimal quantity (2.5 → 2). */
export function wholeUnits(quantity: Decimal): number {
  const units = quantity.unscaled / pow10(quantity.scale);
  return units > 100_000n ? 100_000 : Number(units);
}

export function isWholeQuantity(quantity: Decimal): boolean {
  return quantity.unscaled % pow10(quantity.scale) === 0n;
}

export function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const scale = Math.max(a.scale, b.scale);
  const ua = a.unscaled * pow10(scale - a.scale);
  const ub = b.unscaled * pow10(scale - b.scale);
  return ua < ub ? -1 : ua > ub ? 1 : 0;
}

export function addDecimal(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return {
    unscaled: a.unscaled * pow10(scale - a.scale) + b.unscaled * pow10(scale - b.scale),
    scale,
  };
}

export const ZERO_DECIMAL: Decimal = { unscaled: 0n, scale: 0 };

export function sumBig(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

/** Cap `amounts` so they sum to at most `cap`, scaling by largest remainder when they exceed it. */
export function capAmounts(amounts: readonly bigint[], cap: bigint): bigint[] {
  const total = sumBig(amounts);
  if (total <= cap) return [...amounts];
  if (cap <= 0n) return amounts.map(() => 0n);
  return allocate(cap, amounts);
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
