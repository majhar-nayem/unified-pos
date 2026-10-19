import { allocate } from '../money/allocate.js';
import { divRound, parseDecimal, pow10, type RoundingMode } from '../money/decimal.js';
import type { TaxComponent } from './tax-resolver.js';
import type { LineTax } from './types.js';

export interface TaxComputation {
  readonly taxes: LineTax[];
  readonly taxMinor: bigint;
}

/**
 * Step 5 of docs/01-system-architecture.md §7.2 for one amount.
 *
 * Exclusive: each component is rounded on its own; a compound component applies to the base
 * plus every component before it. Inclusive: the combined multiplier is computed exactly as a
 * rational so tax = amount × K / (1 + K) rounds once, and the total is split across components
 * by largest remainder, so base + Σ tax = amount exactly.
 */
export function computeTaxes(
  amountMinor: bigint,
  components: readonly TaxComponent[],
  inclusive: boolean,
  mode: RoundingMode,
): TaxComputation {
  if (components.length === 0) return { taxes: [], taxMinor: 0n };
  const rates = components.map((c) => {
    const rate = parseDecimal(c.rate);
    if (rate.unscaled < 0n) throw new RangeError(`Tax rate ${c.name} must not be negative`);
    return rate;
  });

  if (!inclusive) {
    const taxes: LineTax[] = [];
    let accrued = 0n;
    components.forEach((component, i) => {
      const rate = rates[i]!;
      const base = component.compound ? amountMinor + accrued : amountMinor;
      const tax = divRound(base * rate.unscaled, pow10(rate.scale), mode);
      accrued += tax;
      taxes.push({
        ruleId: component.ruleId,
        name: component.name,
        rate: component.rate,
        amountMinor: tax,
      });
    });
    return { taxes, taxMinor: accrued };
  }

  // Exact rational bookkeeping: running = (base + taxes so far) / base as num/den.
  let runningNum = 1n;
  let runningDen = 1n;
  const shares: bigint[] = []; // each component's exact share, on a common denominator (built below)
  const shareDens: bigint[] = [];
  components.forEach((component, i) => {
    const rate = rates[i]!;
    const scale = pow10(rate.scale);
    let num: bigint;
    let den: bigint;
    if (component.compound) {
      num = runningNum * rate.unscaled;
      den = runningDen * scale;
    } else {
      num = rate.unscaled;
      den = scale;
    }
    shares.push(num);
    shareDens.push(den);
    // running += num/den
    runningNum = runningNum * den + num * runningDen;
    runningDen = runningDen * den;
  });
  // K = running - 1 = (runningNum - runningDen) / runningDen; tax = amount × K / (1 + K)
  const kNum = runningNum - runningDen;
  const taxMinor = kNum === 0n ? 0n : divRound(amountMinor * kNum, runningNum, mode);
  const common = shareDens.reduce((acc, d) => acc * d, 1n);
  const weights = shares.map((num, i) => num * (common / shareDens[i]!));
  const split = allocate(taxMinor, weights);
  return {
    taxes: components.map((component, i) => ({
      ruleId: component.ruleId,
      name: component.name,
      rate: component.rate,
      amountMinor: split[i]!,
    })),
    taxMinor,
  };
}
