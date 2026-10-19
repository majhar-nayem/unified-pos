import { describe, expect, it } from 'vitest';

import {
  isForbiddenFieldName,
  maskCardLikeNumbers,
  passesLuhn,
  redactForStorage,
} from './redaction.js';

describe('redaction', () => {
  it('flags PAN, CVV, track and expiry names and leaves scheme-permitted fields alone', () => {
    for (const bad of [
      'pan',
      'card_pan',
      'cardNumber',
      'card_number',
      'cvv',
      'cvc2',
      'track2',
      'track_data',
      'expiry',
      'card_expiry',
      'exp_month',
      'expiration_date',
      'primary_account_number',
      'magstripe',
    ])
      expect(isForbiddenFieldName(bad), bad).toBe(true);
    for (const ok of [
      'last4',
      'card_brand',
      'entry_mode',
      'auth_code',
      'token_ref',
      'scheme_reference',
      'offline_expires_at',
      'expires_at',
      'company',
      'span_id',
      'panel',
      'cidr',
    ])
      expect(isForbiddenFieldName(ok), ok).toBe(false);
  });

  it('masks Luhn-valid 13–19 digit runs and leaves other numbers', () => {
    expect(passesLuhn('4242424242424242')).toBe(true);
    expect(passesLuhn('4242424242424241')).toBe(false);
    expect(maskCardLikeNumbers('card 4242 4242 4242 4242 approved')).toBe(
      'card ************4242 approved',
    );
    expect(maskCardLikeNumbers('ref 1234567890123 and 0190f8a0')).toBe(
      'ref 1234567890123 and 0190f8a0',
    ); // 13 digits, Luhn fails
    expect(maskCardLikeNumbers('amount 123456')).toBe('amount 123456');
  });

  it('redacts recursively, converts bigints and dates, and caps depth', () => {
    const out = redactForStorage({
      amount: 1000n,
      at: new Date('2026-10-18T00:00:00Z'),
      card: { pan: '4242424242424242', last4: '4242', cvv: '123' },
      authorization: 'Bearer sk_test_x',
      note: 'customer card 4242424242424242',
      nested: [{ track2: 'x' }],
    });
    expect(out).toEqual({
      amount: '1000',
      at: '2026-10-18T00:00:00.000Z',
      card: { pan: '[redacted]', last4: '4242', cvv: '[redacted]' },
      authorization: '[redacted]',
      note: 'customer card ************4242',
      nested: [{ track2: '[redacted]' }],
    });
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 40; i++) deep = deep.child = {} as Record<string, unknown>;
    expect(JSON.stringify(redactForStorage(root))).toContain('[redacted]');
  });
});
