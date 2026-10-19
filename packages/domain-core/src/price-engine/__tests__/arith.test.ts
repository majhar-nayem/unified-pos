import { describe, expect, it } from 'vitest';

import { parseDecimal } from '../../money/decimal.js';
import {
  addDecimal,
  capAmounts,
  compareDecimal,
  isWholeQuantity,
  minBig,
  nonNegativeMinor,
  parseQuantity,
  percentOf,
  sumBig,
  wholeUnits,
  ZERO_DECIMAL,
} from '../arith.js';

const d = parseDecimal;

describe('arith', () => {
  it('percentOf validates the range and rounds', () => {
    expect(percentOf(1000n, '10', 'HALF_UP', 'x')).toBe(100n);
    expect(percentOf(999n, '12.5', 'HALF_UP', 'x')).toBe(125n);
    expect(percentOf(999n, '12.5', 'DOWN', 'x')).toBe(124n);
    expect(percentOf(1000n, '0', 'HALF_UP', 'x')).toBe(0n);
    expect(percentOf(1000n, '100', 'HALF_UP', 'x')).toBe(1000n);
    expect(percentOf(1000n, 100, 'HALF_UP', 'x')).toBe(1000n);
    expect(percentOf(1000n, '100.00', 'HALF_UP', 'x')).toBe(1000n);
    expect(() => percentOf(1000n, '100.01', 'HALF_UP', 'Discount d')).toThrow(
      'Discount d: percent must be between 0 and 100',
    );
    expect(() => percentOf(1000n, '-0.01', 'HALF_UP', 'Discount d')).toThrow(
      'Discount d: percent must be between 0 and 100',
    );
  });

  it('nonNegativeMinor and parseQuantity reject negatives with the label', () => {
    expect(nonNegativeMinor('0', 'a')).toBe(0n);
    expect(nonNegativeMinor(5, 'a')).toBe(5n);
    expect(() => nonNegativeMinor(-1, 'Charge c')).toThrow('Charge c: amount must not be negative');
    expect(parseQuantity('0', 'l').unscaled).toBe(0n);
    expect(parseQuantity('1.5', 'l')).toEqual({ unscaled: 15n, scale: 1 });
    expect(() => parseQuantity('-0.0001', 'Line l1')).toThrow(
      'Line l1: quantity must not be negative',
    );
  });

  it('wholeUnits truncates, clamps and handles scales', () => {
    expect(wholeUnits(d('0'))).toBe(0);
    expect(wholeUnits(d('0.9999'))).toBe(0);
    expect(wholeUnits(d('2.5'))).toBe(2);
    expect(wholeUnits(d('3'))).toBe(3);
    expect(wholeUnits(d('12.000'))).toBe(12);
    expect(wholeUnits(d('100000'))).toBe(100_000);
    expect(wholeUnits(d('100001'))).toBe(100_000);
    expect(wholeUnits(d('99999.9'))).toBe(99_999);
    expect(wholeUnits(d('1000000000'))).toBe(100_000);
  });

  it('isWholeQuantity', () => {
    expect(isWholeQuantity(d('3'))).toBe(true);
    expect(isWholeQuantity(d('3.0000'))).toBe(true);
    expect(isWholeQuantity(d('3.0001'))).toBe(false);
    expect(isWholeQuantity(d('0.5'))).toBe(false);
    expect(isWholeQuantity(d('0'))).toBe(true);
  });

  it('compareDecimal and addDecimal align scales', () => {
    expect(compareDecimal(d('1.50'), d('1.5'))).toBe(0);
    expect(compareDecimal(d('1.5'), d('1.51'))).toBe(-1);
    expect(compareDecimal(d('2'), d('1.9999'))).toBe(1);
    expect(compareDecimal(d('0.05'), d('0.5'))).toBe(-1);
    expect(addDecimal(d('1.5'), d('2.25'))).toEqual({ unscaled: 375n, scale: 2 });
    expect(addDecimal(d('1'), d('0.001'))).toEqual({ unscaled: 1001n, scale: 3 });
    expect(addDecimal(ZERO_DECIMAL, d('7'))).toEqual({ unscaled: 7n, scale: 0 });
    expect(addDecimal(d('0.001'), d('1'))).toEqual({ unscaled: 1001n, scale: 3 });
  });

  it('capAmounts leaves small totals, scales larger ones exactly, and handles a zero cap', () => {
    expect(capAmounts([3n, 4n], 7n)).toEqual([3n, 4n]);
    expect(capAmounts([3n, 4n], 100n)).toEqual([3n, 4n]);
    expect(capAmounts([700n, 300n], 333n)).toEqual([233n, 100n]);
    expect(capAmounts([3n, 4n], 0n)).toEqual([0n, 0n]);
    expect(capAmounts([3n, 4n], -5n)).toEqual([0n, 0n]);
    expect(capAmounts([], 5n)).toEqual([]);
    const original = [3n, 4n];
    expect(capAmounts(original, 100n)).not.toBe(original);
    expect(capAmounts([5n, 5n], 9n).reduce((a, b) => a + b, 0n)).toBe(9n);
  });

  it('sumBig and minBig', () => {
    expect(sumBig([])).toBe(0n);
    expect(sumBig([1n, 2n, 3n])).toBe(6n);
    expect(minBig(1n, 2n)).toBe(1n);
    expect(minBig(2n, 1n)).toBe(1n);
    expect(minBig(2n, 2n)).toBe(2n);
  });
});
