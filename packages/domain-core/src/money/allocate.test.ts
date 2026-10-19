import { describe, expect, it } from 'vitest';

import { allocate, allocateEvenly, allocateMoney } from './allocate.js';
import { money } from './money.js';

describe('largest-remainder allocation', () => {
  it('sums exactly to the total', () => {
    expect(allocate(100n, [333n, 333n, 334n])).toEqual([33n, 33n, 34n]);
    expect(allocate(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(allocate(1n, [1n, 1n, 1n])).toEqual([1n, 0n, 0n]);
    expect(allocate(5n, [0n, 7n])).toEqual([0n, 5n]);
  });

  it('breaks ties by position for determinism', () => {
    expect(allocate(2n, [1n, 1n, 1n, 1n])).toEqual([1n, 1n, 0n, 0n]);
  });

  it('allocates negative totals by magnitude', () => {
    expect(allocate(-100n, [1n, 1n, 1n])).toEqual([-34n, -33n, -33n]);
  });

  it('handles zero totals and empty inputs', () => {
    expect(allocate(0n, [1n, 2n])).toEqual([0n, 0n]);
    expect(allocate(0n, [0n, 0n])).toEqual([0n, 0n]);
    expect(allocate(0n, [])).toEqual([]);
  });

  it('rejects impossible allocations', () => {
    expect(() => allocate(10n, [])).toThrow(RangeError);
    expect(() => allocate(10n, [0n, 0n])).toThrow(RangeError);
    expect(() => allocate(10n, [1n, -1n])).toThrow(RangeError);
  });

  it('property: parts always sum to the total and never differ by more than one unit from exact share', () => {
    let seed = 42;
    const rand = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    for (let round = 0; round < 500; round++) {
      const total = BigInt(rand(100000) - 50000);
      const weights = Array.from({ length: 1 + rand(8) }, () => BigInt(rand(5000)));
      const weightSum = weights.reduce((a, b) => a + b, 0n);
      if (weightSum === 0n) continue;
      const parts = allocate(total, weights);
      expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
      parts.forEach((part, i) => {
        const exactFloor = (total * weights[i]!) / weightSum; // truncated toward zero
        const diff = part - exactFloor;
        expect(diff <= 1n && diff >= -1n).toBe(true);
      });
    }
  });

  it('allocates evenly and as Money', () => {
    expect(allocateEvenly(10n, 3)).toEqual([4n, 3n, 3n]);
    expect(() => allocateEvenly(10n, 0)).toThrow(RangeError);
    expect(allocateMoney(money(100, 'AUD'), [1n, 3n])).toEqual([
      money(25, 'AUD'),
      money(75, 'AUD'),
    ]);
  });
});
