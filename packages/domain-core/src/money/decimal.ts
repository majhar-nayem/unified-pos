/**
 * Minimal exact decimal support built on bigint.
 *
 * Quantities (numeric(14,4)) and rates (numeric(9,6)) arrive as decimal strings and are never
 * converted to floating point. A Decimal is an unscaled bigint plus a scale (number of fractional digits).
 */

export interface Decimal {
  readonly unscaled: bigint;
  readonly scale: number;
}

export type RoundingMode =
  /** Round half away from zero (2.5 → 3, -2.5 → -3). Default for money. */
  | 'HALF_UP'
  /** Banker's rounding (2.5 → 2, 3.5 → 4). */
  | 'HALF_EVEN'
  /** Round half toward zero (2.5 → 2, -2.5 → -2). */
  | 'HALF_DOWN'
  /** Truncate toward zero. */
  | 'DOWN'
  /** Away from zero. */
  | 'UP'
  /** Toward negative infinity. */
  | 'FLOOR'
  /** Toward positive infinity. */
  | 'CEIL';

const DECIMAL_PATTERN = /^([+-])?(\d+)(?:\.(\d+))?$/;

export function parseDecimal(input: string | number | bigint): Decimal {
  if (typeof input === 'bigint') return { unscaled: input, scale: 0 };
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new TypeError(`Not a finite number: ${input}`);
    return parseDecimal(numberToPlainString(input));
  }
  const match = DECIMAL_PATTERN.exec(input.trim());
  if (!match) throw new TypeError(`Not a decimal string: "${input}"`);
  const [, sign, intPart, fracPart = ''] = match;
  const unscaled = BigInt(`${intPart}${fracPart}`);
  return { unscaled: sign === '-' ? -unscaled : unscaled, scale: fracPart.length };
}

function numberToPlainString(n: number): string {
  // Avoid exponent notation for very small / large numbers; numbers in inputs are expected to be modest.
  const s = String(n);
  if (!/e/i.test(s)) return s;
  return n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}

export function decimalToString(d: Decimal): string {
  const negative = d.unscaled < 0n;
  let digits = (negative ? -d.unscaled : d.unscaled).toString();
  if (d.scale === 0) return `${negative ? '-' : ''}${digits}`;
  digits = digits.padStart(d.scale + 1, '0');
  const intPart = digits.slice(0, digits.length - d.scale);
  const fracPart = digits.slice(digits.length - d.scale);
  return `${negative ? '-' : ''}${intPart}.${fracPart}`;
}

export function pow10(exponent: number): bigint {
  if (!Number.isInteger(exponent) || exponent < 0) {
    throw new RangeError(`Exponent must be a non-negative integer, got ${exponent}`);
  }
  return 10n ** BigInt(exponent);
}

/**
 * Integer division with explicit rounding. `denominator` must be non-zero; its sign is normalised.
 */
export function divRound(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode = 'HALF_UP',
): bigint {
  if (denominator === 0n) throw new RangeError('Division by zero');
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const quotient = numerator / denominator; // truncates toward zero
  const remainder = numerator % denominator; // sign follows numerator
  if (remainder === 0n) return quotient;

  const negative = numerator < 0n;
  const absRemainder = remainder < 0n ? -remainder : remainder;
  const twice = absRemainder * 2n;
  const awayFromZero = negative ? quotient - 1n : quotient + 1n;

  switch (mode) {
    case 'DOWN':
      return quotient;
    case 'UP':
      return awayFromZero;
    case 'FLOOR':
      return negative ? quotient - 1n : quotient;
    case 'CEIL':
      return negative ? quotient : quotient + 1n;
    case 'HALF_UP':
      return twice >= denominator ? awayFromZero : quotient;
    case 'HALF_DOWN':
      return twice > denominator ? awayFromZero : quotient;
    case 'HALF_EVEN': {
      if (twice > denominator) return awayFromZero;
      if (twice < denominator) return quotient;
      return quotient % 2n === 0n ? quotient : awayFromZero;
    }
    default: {
      const exhaustive: never = mode;
      throw new RangeError(`Unknown rounding mode ${String(exhaustive)}`);
    }
  }
}

/** Multiply an integer amount by a decimal factor, rounding to an integer. */
export function mulDecimal(
  amount: bigint,
  factor: Decimal,
  mode: RoundingMode = 'HALF_UP',
): bigint {
  return divRound(amount * factor.unscaled, pow10(factor.scale), mode);
}

/** amount × (num / den) rounded to an integer. */
export function mulDiv(
  amount: bigint,
  num: bigint,
  den: bigint,
  mode: RoundingMode = 'HALF_UP',
): bigint {
  return divRound(amount * num, den, mode);
}

export function isDecimalZero(d: Decimal): boolean {
  return d.unscaled === 0n;
}

export function isDecimalNegative(d: Decimal): boolean {
  return d.unscaled < 0n;
}
