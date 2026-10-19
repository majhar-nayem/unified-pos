import { ruleInvalid } from './types.js';

/**
 * Quantities are numeric(14,4). Inside the aggregate they are "scaled integers" (× 10 000) so
 * arithmetic is exact; on the wire and in the database they are canonical 4-decimal text.
 */
export const QUANTITY_SCALE = 4;
const FACTOR = 10_000n;
const MAX_UNSCALED = 99_999_999_999_999_999n; // numeric(14,4): 10 integer digits + 4 decimals

/** "1" → 10000n, "1.5" → 15000n. Rejects more than 4 decimals, negatives and garbage. */
export function parseQuantity(text: string | number): bigint {
  const s = typeof text === 'number' ? String(text) : text.trim();
  const m = /^(\d{1,10})(?:\.(\d{1,4}))?$/.exec(s);
  if (!m)
    throw ruleInvalid(
      'QUANTITY_INVALID',
      `Quantity must be a decimal with at most 4 places, got "${s}"`,
    );
  const value = BigInt(m[1]!) * FACTOR + BigInt((m[2] ?? '').padEnd(4, '0'));
  if (value > MAX_UNSCALED) throw ruleInvalid('QUANTITY_INVALID', 'Quantity is too large');
  return value;
}

export function formatQuantity(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const int = abs / FACTOR;
  const frac = (abs % FACTOR).toString().padStart(4, '0');
  return `${negative ? '-' : ''}${int}.${frac}`;
}

/** Normalise any accepted spelling to canonical 4-decimal text. */
export function canonicalQuantity(text: string | number): string {
  return formatQuantity(parseQuantity(text));
}

export const ZERO_QUANTITY = '0.0000';
