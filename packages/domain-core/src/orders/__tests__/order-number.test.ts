import { describe, expect, it } from 'vitest';

import {
  CLIENT_ORDER_REF,
  NEXT_ORDER_NUMBER_SQL,
  assertCanAssignNumber,
  assertClientOrderRef,
  displayOrderNumber,
  receiptBaseNumber,
  resolveBusinessDate,
} from '../order-number.js';
import { parseQuantity, formatQuantity, canonicalQuantity } from '../quantity.js';
import { OrderRuleError } from '../types.js';
import { draft, makeCtx } from './helpers.js';

describe('business date', () => {
  const sydney = { timezone: 'Australia/Sydney', boundary: '04:00' };
  it('rolls over at the location boundary in the location time zone', () => {
    // 2026-10-18 03:59 Sydney (AEDT, UTC+11) is still the 17th; 04:00 starts the 18th
    expect(resolveBusinessDate({ now: new Date('2026-10-17T16:59:00Z'), ...sydney })).toBe(
      '2026-10-17',
    );
    expect(resolveBusinessDate({ now: new Date('2026-10-17T17:00:00Z'), ...sydney })).toBe(
      '2026-10-18',
    );
    expect(
      resolveBusinessDate({
        now: new Date('2026-10-18T12:00:00Z'),
        timezone: 'Australia/Perth',
        boundary: '04:00',
      }),
    ).toBe('2026-10-18');
  });
  it('an offline order keeps the business date of the device clock', () => {
    expect(
      resolveBusinessDate({
        now: new Date('2026-10-20T00:00:00Z'),
        clientCreatedAt: new Date('2026-10-18T05:00:00Z'),
        ...sydney,
      }),
    ).toBe('2026-10-18');
  });
});

describe('order numbers', () => {
  it('the client reference is a register-local string, the canonical number an integer from the server', () => {
    expect(CLIENT_ORDER_REF.test('R1-000123')).toBe(true);
    for (const bad of ['', ' R1', 'R 1', '-R1', 'a'.repeat(65)])
      expect(() => assertClientOrderRef(bad)).toThrow(OrderRuleError);
    const o = draft(makeCtx(), { clientOrderRef: 'R1-000123' });
    expect(displayOrderNumber(o)).toBe('R1-000123');
    expect(displayOrderNumber({ ...o, orderNumber: 42 })).toBe('0042');
    expect(receiptBaseNumber({ ...o, orderNumber: 42 })).toBe('20261018-0042');
    expect(displayOrderNumber({ orderNumber: null, clientOrderRef: null })).toBe('—');
  });

  it('a canonical number is assigned once, to a draft, and is positive', () => {
    const o = draft(makeCtx());
    expect(() => assertCanAssignNumber(o, 1)).not.toThrow();
    for (const n of [0, -1, 1.5, Number.NaN])
      expect(() => assertCanAssignNumber(o, n)).toThrow(OrderRuleError);
    expect(() => assertCanAssignNumber({ ...o, orderNumber: 3 }, 4)).toThrow(/already/);
    expect(() => assertCanAssignNumber({ ...o, status: 'open' }, 4)).toThrow(/only|place/i);
  });

  it('the sequence statement is one atomic upsert returning the number just taken', () => {
    expect(NEXT_ORDER_NUMBER_SQL).toMatch(/ON CONFLICT \(location_id, business_date\)/);
    expect(NEXT_ORDER_NUMBER_SQL).toMatch(/next_value \+ 1/);
    expect(NEXT_ORDER_NUMBER_SQL).toMatch(/RETURNING next_value - 1/);
  });
});

describe('quantity', () => {
  it('parses to a scaled integer and formats to canonical text', () => {
    expect(parseQuantity('1')).toBe(10000n);
    expect(parseQuantity('0.0001')).toBe(1n);
    expect(parseQuantity('1.5')).toBe(15000n);
    expect(parseQuantity(2)).toBe(20000n);
    expect(formatQuantity(15000n)).toBe('1.5000');
    expect(formatQuantity(1n)).toBe('0.0001');
    expect(canonicalQuantity('12')).toBe('12.0000');
    expect(canonicalQuantity('1234567890.1234')).toBe('1234567890.1234');
  });
  it('rejects negatives, too many decimals, exponents and overflow', () => {
    for (const bad of ['-1', '1.00001', '1e3', ' ', '1,5', '12345678901', '.5'])
      expect(() => parseQuantity(bad)).toThrow(OrderRuleError);
  });
});
