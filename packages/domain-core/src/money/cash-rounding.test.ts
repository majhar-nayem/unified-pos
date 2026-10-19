import { describe, expect, it } from 'vitest';

import { roundForCash, roundToCashInterval } from './cash-rounding.js';
import { CurrencyRegistry } from './currency.js';
import { money } from './money.js';

describe('AUD 5c cash rounding', () => {
  // Reserve Bank guideline: 1 & 2 round down to 0, 3 & 4 round up to 5, 6 & 7 round down to 5, 8 & 9 round up to 10.
  const table: [number, number][] = [
    [1000, 1000],
    [1001, 1000],
    [1002, 1000],
    [1003, 1005],
    [1004, 1005],
    [1005, 1005],
    [1006, 1005],
    [1007, 1005],
    [1008, 1010],
    [1009, 1010],
  ];

  for (const [amount, expected] of table) {
    it(`${amount} → ${expected}`, () => {
      const result = roundForCash(money(amount, 'AUD'));
      expect(result.roundedMinor).toBe(BigInt(expected));
      expect(result.roundingMinor).toBe(BigInt(expected - amount));
    });
  }

  it('rounds refunds symmetrically', () => {
    expect(roundForCash(money(-1883, 'AUD'))).toEqual({ roundedMinor: -1885n, roundingMinor: -2n });
    expect(roundForCash(money(-1882, 'AUD'))).toEqual({ roundedMinor: -1880n, roundingMinor: 2n });
  });

  it('leaves currencies without a rule untouched', () => {
    expect(roundForCash(money(1003, 'USD'))).toEqual({ roundedMinor: 1003n, roundingMinor: 0n });
  });

  it('uses a tenant-registered rule', () => {
    const registry = new CurrencyRegistry([
      { code: 'EUR', exponent: 2, name: 'Euro', cashRounding: { intervalMinor: 5, mode: 'DOWN' } },
    ]);
    expect(roundForCash(money(1009, 'EUR'), registry)).toEqual({
      roundedMinor: 1005n,
      roundingMinor: -4n,
    });
  });
});

describe('roundToCashInterval modes', () => {
  it('NEAREST_HALF_UP vs NEAREST_HALF_DOWN on an exact half (10c interval)', () => {
    expect(
      roundToCashInterval(1005n, { intervalMinor: 10, mode: 'NEAREST_HALF_UP' }).roundedMinor,
    ).toBe(1010n);
    expect(
      roundToCashInterval(1005n, { intervalMinor: 10, mode: 'NEAREST_HALF_DOWN' }).roundedMinor,
    ).toBe(1000n);
  });

  it('UP and DOWN always move away from / toward zero', () => {
    expect(roundToCashInterval(1001n, { intervalMinor: 5, mode: 'UP' }).roundedMinor).toBe(1005n);
    expect(roundToCashInterval(1004n, { intervalMinor: 5, mode: 'DOWN' }).roundedMinor).toBe(1000n);
    expect(roundToCashInterval(-1001n, { intervalMinor: 5, mode: 'UP' }).roundedMinor).toBe(-1005n);
  });
});
