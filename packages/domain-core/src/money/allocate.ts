import type { Money } from './money.js';

/**
 * Largest-remainder (Hamilton) allocation.
 *
 * Splits `total` across `weights` proportionally so the parts sum to `total` exactly
 * (docs/01-system-architecture.md §7.2 step 4). Each part starts at floor(total × w / Σw);
 * the leftover units go one at a time to the parts with the largest fractional remainder,
 * ties broken by position (earlier wins) so the result is deterministic on every device.
 *
 * Negative totals are allocated by magnitude and negated, so a discount of -100 across
 * weights [1, 1, 1] yields [-34, -33, -33].
 */
export function allocate(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) {
    if (total === 0n) return [];
    throw new RangeError('Cannot allocate a non-zero total across zero weights');
  }
  for (const w of weights) {
    if (w < 0n) throw new RangeError('Allocation weights must be non-negative');
  }
  const weightSum = weights.reduce((acc, w) => acc + w, 0n);
  if (weightSum === 0n) {
    if (total === 0n) return weights.map(() => 0n);
    throw new RangeError('Cannot allocate a non-zero total when all weights are zero');
  }

  const negative = total < 0n;
  const magnitude = negative ? -total : total;

  const shares: bigint[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let allocated = 0n;
  for (let i = 0; i < weights.length; i++) {
    const scaled = magnitude * weights[i]!;
    const share = scaled / weightSum;
    shares.push(share);
    remainders.push({ index: i, remainder: scaled % weightSum });
    allocated += share;
  }

  let leftover = magnitude - allocated;
  remainders.sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.index - b.index;
  });
  for (const r of remainders) {
    if (leftover === 0n) break;
    shares[r.index] = shares[r.index]! + 1n;
    leftover -= 1n;
  }

  return negative ? shares.map((s) => -s) : shares;
}

/** Allocate evenly across `parts` buckets; the first buckets absorb the remainder. */
export function allocateEvenly(total: bigint, parts: number): bigint[] {
  if (!Number.isInteger(parts) || parts <= 0)
    throw new RangeError('parts must be a positive integer');
  return allocate(
    total,
    Array.from({ length: parts }, () => 1n),
  );
}

export function allocateMoney(total: Money, weights: readonly bigint[]): Money[] {
  return allocate(total.amountMinor, weights).map((amountMinor) => ({
    amountMinor,
    currency: total.currency,
  }));
}
