import { describe, expect, it } from 'vitest';

import { decimalToString, divRound, mulDecimal, parseDecimal } from './decimal.js';

describe('parseDecimal', () => {
  it('parses integers, fractions and signs', () => {
    expect(parseDecimal('1.2550')).toEqual({ unscaled: 12550n, scale: 4 });
    expect(parseDecimal('0.10')).toEqual({ unscaled: 10n, scale: 2 });
    expect(parseDecimal('-3')).toEqual({ unscaled: -3n, scale: 0 });
    expect(parseDecimal(2)).toEqual({ unscaled: 2n, scale: 0 });
    expect(parseDecimal(0.5)).toEqual({ unscaled: 5n, scale: 1 });
    expect(parseDecimal(7n)).toEqual({ unscaled: 7n, scale: 0 });
  });

  it('rejects malformed input', () => {
    expect(() => parseDecimal('1,5')).toThrow(TypeError);
    expect(() => parseDecimal('abc')).toThrow(TypeError);
    expect(() => parseDecimal('')).toThrow(TypeError);
    expect(() => parseDecimal(Number.NaN)).toThrow(TypeError);
  });

  it('round-trips through decimalToString', () => {
    for (const s of ['0', '1', '0.05', '-0.05', '1234.5678', '-0.0001']) {
      expect(decimalToString(parseDecimal(s))).toBe(s);
    }
  });
});

describe('divRound', () => {
  const cases: [bigint, bigint, Record<string, bigint>][] = [
    // 2.5
    [5n, 2n, { HALF_UP: 3n, HALF_DOWN: 2n, HALF_EVEN: 2n, DOWN: 2n, UP: 3n, FLOOR: 2n, CEIL: 3n }],
    // 3.5
    [7n, 2n, { HALF_UP: 4n, HALF_DOWN: 3n, HALF_EVEN: 4n, DOWN: 3n, UP: 4n, FLOOR: 3n, CEIL: 4n }],
    // -2.5
    [
      -5n,
      2n,
      { HALF_UP: -3n, HALF_DOWN: -2n, HALF_EVEN: -2n, DOWN: -2n, UP: -3n, FLOOR: -3n, CEIL: -2n },
    ],
    // 2.4
    [
      24n,
      10n,
      { HALF_UP: 2n, HALF_DOWN: 2n, HALF_EVEN: 2n, DOWN: 2n, UP: 3n, FLOOR: 2n, CEIL: 3n },
    ],
    // -2.6
    [
      -26n,
      10n,
      { HALF_UP: -3n, HALF_DOWN: -3n, HALF_EVEN: -3n, DOWN: -2n, UP: -3n, FLOOR: -3n, CEIL: -2n },
    ],
  ];

  for (const [n, d, expected] of cases) {
    for (const [mode, value] of Object.entries(expected)) {
      it(`${n}/${d} ${mode} = ${value}`, () => {
        expect(divRound(n, d, mode as never)).toBe(value);
      });
    }
  }

  it('is exact when there is no remainder', () => {
    expect(divRound(900n, 3n, 'HALF_EVEN')).toBe(300n);
  });

  it('normalises a negative denominator', () => {
    expect(divRound(5n, -2n, 'HALF_UP')).toBe(-3n);
  });

  it('rejects division by zero', () => {
    expect(() => divRound(1n, 0n)).toThrow(RangeError);
  });
});

describe('mulDecimal', () => {
  it('multiplies by a weighed quantity and rounds once', () => {
    // 599 × 1.2550 = 751.745
    expect(mulDecimal(599n, parseDecimal('1.2550'))).toBe(752n);
    expect(mulDecimal(599n, parseDecimal('1.2550'), 'DOWN')).toBe(751n);
  });
});
