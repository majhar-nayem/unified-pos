import { defaultCurrencies, type CurrencyRegistry, normaliseCode } from './currency.js';
import {
  decimalToString,
  mulDecimal,
  parseDecimal,
  pow10,
  type Decimal,
  type RoundingMode,
} from './decimal.js';

/**
 * Money is an exact integer number of minor units (cents) in one ISO 4217 currency.
 * No floating point anywhere (docs/01-system-architecture.md ADR 004).
 */
export interface Money {
  readonly amountMinor: bigint;
  readonly currency: string;
}

export type MinorAmountInput = bigint | number | string;

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Currency mismatch: ${a} vs ${b}`);
    this.name = 'CurrencyMismatchError';
  }
}

/** Coerce a JSON-friendly minor amount (number or integer string) to bigint. */
export function toMinor(value: MinorAmountInput): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      throw new TypeError(`Minor amount must be a safe integer, got ${value}`);
    return BigInt(value);
  }
  if (!/^[+-]?\d+$/.test(value.trim()))
    throw new TypeError(`Minor amount must be an integer string, got "${value}"`);
  return BigInt(value.trim());
}

export function money(amountMinor: MinorAmountInput, currency: string): Money {
  return { amountMinor: toMinor(amountMinor), currency: normaliseCode(currency) };
}

export function zero(currency: string): Money {
  return money(0n, currency);
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

export function negate(a: Money): Money {
  return { amountMinor: -a.amountMinor, currency: a.currency };
}

export function abs(a: Money): Money {
  return a.amountMinor < 0n ? negate(a) : a;
}

export function sum(items: readonly Money[], currency: string): Money {
  let total = zero(currency);
  for (const item of items) total = add(total, item);
  return total;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

export function isZero(a: Money): boolean {
  return a.amountMinor === 0n;
}

export function isNegative(a: Money): boolean {
  return a.amountMinor < 0n;
}

export function min(a: Money, b: Money): Money {
  return compare(a, b) <= 0 ? a : b;
}

export function max(a: Money, b: Money): Money {
  return compare(a, b) >= 0 ? a : b;
}

/**
 * Multiply by an exact decimal factor (quantity, rate) and round to a whole minor unit.
 * The factor may be a decimal string ("1.2550"), a number, or a parsed Decimal.
 */
export function multiply(
  a: Money,
  factor: Decimal | string | number,
  mode: RoundingMode = 'HALF_UP',
): Money {
  const decimal = typeof factor === 'object' ? factor : parseDecimal(factor);
  return { amountMinor: mulDecimal(a.amountMinor, decimal, mode), currency: a.currency };
}

/** `percent` is in percentage points: percentage(m, "12.5") is 12.5 % of m. */
export function percentage(
  a: Money,
  percent: Decimal | string | number,
  mode: RoundingMode = 'HALF_UP',
): Money {
  const p = typeof percent === 'object' ? percent : parseDecimal(percent);
  return multiply(a, { unscaled: p.unscaled, scale: p.scale + 2 }, mode);
}

/** Parse a major-unit decimal string ("4.50") into minor units using the currency's exponent. */
export function fromDecimalString(
  value: string,
  currency: string,
  registry: CurrencyRegistry = defaultCurrencies,
): Money {
  const def = registry.get(currency);
  const parsed = parseDecimal(value);
  if (parsed.scale > def.exponent) {
    throw new RangeError(`"${value}" has more than ${def.exponent} decimal places for ${def.code}`);
  }
  const amountMinor = parsed.unscaled * pow10(def.exponent - parsed.scale);
  return { amountMinor, currency: def.code };
}

/** Render as a major-unit decimal string with the currency's exponent ("4.50", "1200", "1.250"). */
export function toDecimalString(a: Money, registry: CurrencyRegistry = defaultCurrencies): string {
  const def = registry.get(a.currency);
  return decimalToString({ unscaled: a.amountMinor, scale: def.exponent });
}

/** JSON-safe representation: bigint as a string. */
export function toJson(a: Money): { amountMinor: string; currency: string } {
  return { amountMinor: a.amountMinor.toString(), currency: a.currency };
}

export function fromJson(json: { amountMinor: MinorAmountInput; currency: string }): Money {
  return money(json.amountMinor, json.currency);
}
