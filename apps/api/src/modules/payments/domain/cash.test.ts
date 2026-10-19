import { describe, expect, it } from 'vitest';

import { CashTenderError, calculateCashTender } from './cash.js';

describe('cash tender (AUD 5c rounding, change)', () => {
  const settle = (outstandingMinor: bigint, tenderedMinor?: bigint) =>
    calculateCashTender({ outstandingMinor, currency: 'AUD', tenderedMinor });

  const table: [bigint, bigint, bigint][] = [
    // outstanding, due, rounding
    [1880n, 1880n, 0n],
    [1881n, 1880n, -1n],
    [1882n, 1880n, -2n],
    [1883n, 1885n, 2n],
    [1884n, 1885n, 1n],
    [1885n, 1885n, 0n],
    [1886n, 1885n, -1n],
    [1887n, 1885n, -2n],
    [1888n, 1890n, 2n],
    [1889n, 1890n, 1n],
  ];
  for (const [outstanding, due, rounding] of table) {
    it(`settling ${outstanding} in cash takes ${due} (rounding ${rounding})`, () => {
      const calc = settle(outstanding);
      expect(calc.dueMinor).toBe(due);
      expect(calc.roundingMinor).toBe(rounding);
      expect(calc.dueMinor - outstanding).toBe(rounding);
      expect(calc.changeMinor).toBe(0n);
      expect(calc.settlesBalance).toBe(true);
    });
  }

  it('gives change from the rounded amount, not the exact one', () => {
    const calc = settle(1883n, 2000n);
    expect(calc).toMatchObject({
      dueMinor: 1885n,
      tenderedMinor: 2000n,
      changeMinor: 115n,
      roundingMinor: 2n,
    });
  });

  it('a partial cash payment is exact and carries no rounding; the final cash tender rounds', () => {
    const partial = calculateCashTender({
      outstandingMinor: 1883n,
      currency: 'AUD',
      requestedMinor: 1000n,
    });
    expect(partial).toMatchObject({ dueMinor: 1000n, roundingMinor: 0n, settlesBalance: false });
    const final = calculateCashTender({ outstandingMinor: 883n, currency: 'AUD' });
    expect(final).toMatchObject({ dueMinor: 885n, roundingMinor: 2n, settlesBalance: true });
  });

  it('currencies without a cash rounding rule are never rounded', () => {
    const calc = calculateCashTender({ outstandingMinor: 1883n, currency: 'USD' });
    expect(calc).toMatchObject({ dueMinor: 1883n, roundingMinor: 0n });
  });

  it('refuses tendering less than due, more than outstanding, nothing owed, or a balance that rounds to nothing', () => {
    expect(() => settle(1883n, 1884n)).toThrow(CashTenderError);
    expect(() => settle(1883n, 1884n)).toThrow(/less than/);
    expect(() =>
      calculateCashTender({ outstandingMinor: 100n, currency: 'AUD', requestedMinor: 101n }),
    ).toThrow(/exceeds/);
    expect(() => settle(0n)).toThrow(/nothing outstanding/);
    expect(() => settle(2n)).toThrow(/rounds to nothing/);
    try {
      settle(2n);
    } catch (e) {
      expect((e as CashTenderError).code).toBe('NOTHING_DUE_AFTER_ROUNDING');
    }
  });

  it('property: due is always a multiple of 5 when settling AUD, within 2c of the outstanding amount', () => {
    for (let outstanding = 3n; outstanding < 5_000n; outstanding++) {
      const calc = settle(outstanding);
      expect(calc.dueMinor % 5n).toBe(0n);
      const delta = calc.dueMinor - outstanding;
      expect(delta >= -2n && delta <= 2n).toBe(true);
      expect(calc.roundingMinor).toBe(delta);
    }
  });
});
