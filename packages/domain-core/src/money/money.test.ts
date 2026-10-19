import { describe, expect, it } from 'vitest';

import { CurrencyRegistry, UnknownCurrencyError, defaultCurrencies } from './currency.js';
import {
  CurrencyMismatchError,
  add,
  compare,
  fromDecimalString,
  fromJson,
  money,
  multiply,
  percentage,
  subtract,
  sum,
  toDecimalString,
  toJson,
  toMinor,
} from './money.js';

describe('currency registry', () => {
  it('ships AUD with 2 decimals and 5c cash rounding', () => {
    const aud = defaultCurrencies.get('aud');
    expect(aud.exponent).toBe(2);
    expect(aud.cashRounding).toEqual({ intervalMinor: 5, mode: 'NEAREST_HALF_UP' });
  });

  it('knows zero- and three-decimal currencies', () => {
    expect(defaultCurrencies.get('JPY').exponent).toBe(0);
    expect(defaultCurrencies.get('KWD').exponent).toBe(3);
  });

  it('throws on unknown currencies and allows runtime registration', () => {
    const registry = new CurrencyRegistry();
    expect(() => registry.get('XXX')).toThrow(UnknownCurrencyError);
    registry.register({ code: 'xxx', exponent: 2, name: 'Test' });
    expect(registry.get('XXX').code).toBe('XXX');
  });

  it('rejects invalid definitions', () => {
    const registry = new CurrencyRegistry([]);
    expect(() => registry.register({ code: 'ABC', exponent: -1, name: 'bad' })).toThrow(RangeError);
    expect(() => registry.register({ code: 'AB', exponent: 2, name: 'bad' })).toThrow(TypeError);
    expect(() =>
      registry.register({
        code: 'ABC',
        exponent: 2,
        name: 'bad',
        cashRounding: { intervalMinor: 0, mode: 'UP' },
      }),
    ).toThrow(RangeError);
  });
});

describe('money arithmetic', () => {
  it('coerces numbers and strings to bigint minor units', () => {
    expect(toMinor(450)).toBe(450n);
    expect(toMinor('-12')).toBe(-12n);
    expect(toMinor(7n)).toBe(7n);
    expect(() => toMinor(1.5)).toThrow(TypeError);
    expect(() => toMinor('1.5')).toThrow(TypeError);
    expect(() => toMinor(Number.MAX_SAFE_INTEGER + 1)).toThrow(TypeError);
  });

  it('adds, subtracts and sums in one currency', () => {
    const a = money(450, 'AUD');
    const b = money(50, 'aud');
    expect(add(a, b)).toEqual(money(500, 'AUD'));
    expect(subtract(a, b)).toEqual(money(400, 'AUD'));
    expect(sum([a, b, money(-100, 'AUD')], 'AUD')).toEqual(money(400, 'AUD'));
    expect(compare(a, b)).toBe(1);
  });

  it('refuses to mix currencies', () => {
    expect(() => add(money(1, 'AUD'), money(1, 'NZD'))).toThrow(CurrencyMismatchError);
  });

  it('multiplies by exact decimals and percentages', () => {
    expect(multiply(money(599, 'AUD'), '1.2550')).toEqual(money(752, 'AUD'));
    expect(percentage(money(480, 'AUD'), '25')).toEqual(money(120, 'AUD'));
    expect(percentage(money(1000, 'AUD'), '12.5')).toEqual(money(125, 'AUD'));
    expect(percentage(money(333, 'AUD'), '10')).toEqual(money(33, 'AUD'));
    expect(percentage(money(335, 'AUD'), '10', 'HALF_EVEN')).toEqual(money(34, 'AUD'));
  });

  it('converts between major-unit strings and minor units per currency exponent', () => {
    expect(fromDecimalString('4.50', 'AUD')).toEqual(money(450, 'AUD'));
    expect(fromDecimalString('4.5', 'AUD')).toEqual(money(450, 'AUD'));
    expect(fromDecimalString('1200', 'JPY')).toEqual(money(1200, 'JPY'));
    expect(fromDecimalString('1.250', 'KWD')).toEqual(money(1250, 'KWD'));
    expect(() => fromDecimalString('4.505', 'AUD')).toThrow(RangeError);
    expect(toDecimalString(money(450, 'AUD'))).toBe('4.50');
    expect(toDecimalString(money(-5, 'AUD'))).toBe('-0.05');
    expect(toDecimalString(money(1200, 'JPY'))).toBe('1200');
  });

  it('serialises bigint as string for JSON', () => {
    const json = toJson(money(9007199254740993n, 'AUD'));
    expect(json).toEqual({ amountMinor: '9007199254740993', currency: 'AUD' });
    expect(fromJson(json)).toEqual(money(9007199254740993n, 'AUD'));
  });
});
