/**
 * Currency precision table.
 *
 * ISO 4217 minor-unit exponents plus optional cash rounding rules. Per docs/01-system-architecture.md §1
 * ("currency precision is config, not code") the defaults below are a seed; tenants can register or
 * override entries at runtime through a CurrencyRegistry.
 */

export type CashRoundingMode =
  /** Round to the nearest interval; an exact half rounds away from zero. AUD uses this. */
  | 'NEAREST_HALF_UP'
  /** Round to the nearest interval; an exact half rounds toward zero. */
  | 'NEAREST_HALF_DOWN'
  /** Always round away from zero to the next interval. */
  | 'UP'
  /** Always round toward zero to the previous interval. */
  | 'DOWN';

export interface CashRoundingRule {
  /** Smallest physical cash denomination, in minor units (AUD: 5 = five cents). */
  readonly intervalMinor: number;
  readonly mode: CashRoundingMode;
}

export interface CurrencyDefinition {
  /** ISO 4217 alphabetic code, upper case. */
  readonly code: string;
  /** Number of minor-unit digits (AUD 2, JPY 0, KWD 3). */
  readonly exponent: number;
  readonly name: string;
  /** Rounding applied to cash tenders only (docs/01-system-architecture.md §7.2 step 7). */
  readonly cashRounding?: CashRoundingRule;
}

const AUD_CASH: CashRoundingRule = { intervalMinor: 5, mode: 'NEAREST_HALF_UP' };

export const DEFAULT_CURRENCIES: readonly CurrencyDefinition[] = [
  { code: 'AUD', exponent: 2, name: 'Australian dollar', cashRounding: AUD_CASH },
  {
    code: 'NZD',
    exponent: 2,
    name: 'New Zealand dollar',
    cashRounding: { intervalMinor: 10, mode: 'NEAREST_HALF_UP' },
  },
  { code: 'USD', exponent: 2, name: 'US dollar' },
  {
    code: 'CAD',
    exponent: 2,
    name: 'Canadian dollar',
    cashRounding: { intervalMinor: 5, mode: 'NEAREST_HALF_UP' },
  },
  { code: 'EUR', exponent: 2, name: 'Euro' },
  { code: 'GBP', exponent: 2, name: 'Pound sterling' },
  {
    code: 'CHF',
    exponent: 2,
    name: 'Swiss franc',
    cashRounding: { intervalMinor: 5, mode: 'NEAREST_HALF_UP' },
  },
  { code: 'SGD', exponent: 2, name: 'Singapore dollar' },
  { code: 'HKD', exponent: 2, name: 'Hong Kong dollar' },
  { code: 'INR', exponent: 2, name: 'Indian rupee' },
  { code: 'JPY', exponent: 0, name: 'Japanese yen' },
  { code: 'KRW', exponent: 0, name: 'South Korean won' },
  { code: 'VND', exponent: 0, name: 'Vietnamese dong' },
  { code: 'KWD', exponent: 3, name: 'Kuwaiti dinar' },
  { code: 'BHD', exponent: 3, name: 'Bahraini dinar' },
];

export class CurrencyRegistry {
  private readonly byCode = new Map<string, CurrencyDefinition>();

  constructor(definitions: readonly CurrencyDefinition[] = DEFAULT_CURRENCIES) {
    for (const def of definitions) this.register(def);
  }

  register(definition: CurrencyDefinition): void {
    const code = normaliseCode(definition.code);
    if (
      !Number.isInteger(definition.exponent) ||
      definition.exponent < 0 ||
      definition.exponent > 6
    ) {
      throw new RangeError(`Invalid exponent ${definition.exponent} for currency ${code}`);
    }
    if (
      definition.cashRounding &&
      (!Number.isInteger(definition.cashRounding.intervalMinor) ||
        definition.cashRounding.intervalMinor <= 0)
    ) {
      throw new RangeError(`Invalid cash rounding interval for currency ${code}`);
    }
    this.byCode.set(code, { ...definition, code });
  }

  has(code: string): boolean {
    return this.byCode.has(normaliseCode(code));
  }

  get(code: string): CurrencyDefinition {
    const def = this.byCode.get(normaliseCode(code));
    if (!def) throw new UnknownCurrencyError(code);
    return def;
  }

  codes(): string[] {
    return [...this.byCode.keys()];
  }
}

export class UnknownCurrencyError extends Error {
  constructor(public readonly code: string) {
    super(`Unknown currency "${code}"; register it in the CurrencyRegistry`);
    this.name = 'UnknownCurrencyError';
  }
}

export const defaultCurrencies = new CurrencyRegistry();

export function normaliseCode(code: string): string {
  const upper = code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(upper)) throw new TypeError(`Invalid ISO 4217 currency code "${code}"`);
  return upper;
}
