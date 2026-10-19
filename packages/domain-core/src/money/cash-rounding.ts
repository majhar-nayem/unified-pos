import { type CashRoundingRule, type CurrencyRegistry, defaultCurrencies } from './currency.js';
import type { Money } from './money.js';

export interface CashRoundingResult {
  /** Amount the customer actually hands over / receives. */
  readonly roundedMinor: bigint;
  /** roundedMinor - originalMinor; recorded as `rounding_minor` on the order / cash movement. */
  readonly roundingMinor: bigint;
}

/**
 * Apply a currency's cash rounding rule (AUD: nearest 5 cents) to an amount in minor units.
 * Only cash tenders are rounded (docs/01-system-architecture.md §7.2 step 7). Rounding is symmetric
 * in magnitude, so a refund of -1883 rounds to -1885 just as a sale of 1883 rounds to 1885.
 */
export function roundToCashInterval(
  amountMinor: bigint,
  rule: CashRoundingRule,
): CashRoundingResult {
  const interval = BigInt(rule.intervalMinor);
  const negative = amountMinor < 0n;
  const magnitude = negative ? -amountMinor : amountMinor;
  const remainder = magnitude % interval;

  let roundedMagnitude: bigint;
  if (remainder === 0n) {
    roundedMagnitude = magnitude;
  } else {
    const down = magnitude - remainder;
    const up = down + interval;
    switch (rule.mode) {
      case 'UP':
        roundedMagnitude = up;
        break;
      case 'DOWN':
        roundedMagnitude = down;
        break;
      case 'NEAREST_HALF_UP':
        roundedMagnitude = remainder * 2n >= interval ? up : down;
        break;
      case 'NEAREST_HALF_DOWN':
        roundedMagnitude = remainder * 2n > interval ? up : down;
        break;
      default: {
        const exhaustive: never = rule.mode;
        throw new RangeError(`Unknown cash rounding mode ${String(exhaustive)}`);
      }
    }
  }

  const roundedMinor = negative ? -roundedMagnitude : roundedMagnitude;
  return { roundedMinor, roundingMinor: roundedMinor - amountMinor };
}

/**
 * Round a cash tender for its currency. Currencies without a cash rounding rule return the amount unchanged.
 */
export function roundForCash(
  amount: Money,
  registry: CurrencyRegistry = defaultCurrencies,
): CashRoundingResult {
  const def = registry.get(amount.currency);
  if (!def.cashRounding) return { roundedMinor: amount.amountMinor, roundingMinor: 0n };
  return roundToCashInterval(amount.amountMinor, def.cashRounding);
}
