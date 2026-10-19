import { describe, expect, it } from 'vitest';

import {
  REDACTED,
  isSensitiveKey,
  luhnValid,
  redactAttributesInPlace,
  redactObject,
  scrubString,
} from './redact.js';

describe('key based redaction', () => {
  it.each([
    'password',
    'refreshToken',
    'refresh_token',
    'accessToken',
    'clientSecret',
    'authorization',
    'Set-Cookie',
    'cardNumber',
    'card_number',
    'pan',
    'cvv',
    'pin',
    'pinHash',
    'email',
    'customerEmail',
    'phone',
    'x-api-key',
    'apiKey',
    'dateOfBirth',
    'http.request.header.authorization',
  ])('redacts %s', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    'tenantId',
    'span_id',
    'spanId',
    'route',
    'orderTotal',
    'tokenKind',
    'token_type',
    'device',
    'pinned',
  ])('keeps %s', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe('value scrubbing', () => {
  it('masks emails, JWTs, bearer and operator tokens', () => {
    const jwt = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlc2lnbmF0dXJl';
    expect(scrubString('mail owner@acme.example now')).toBe('mail [email] now');
    expect(scrubString(`token ${jwt}`)).toBe('token [jwt]');
    expect(scrubString('Authorization: Bearer abcdef0123456789')).toBe(
      'Authorization: Bearer [redacted]',
    );
    expect(scrubString('using op_local_operator_token_0001')).toBe('using [token]');
  });

  it('masks card numbers that pass Luhn and leaves other digit runs alone', () => {
    expect(luhnValid('4242424242424242')).toBe(true);
    expect(scrubString('card 4242 4242 4242 4242 declined')).toBe('card [pan] declined');
    expect(scrubString('card 4242-4242-4242-4242')).toBe('card [pan]');
    expect(scrubString('order 1234567890123')).toBe('order 1234567890123'); // fails Luhn
    expect(scrubString('total 12345')).toBe('total 12345');
  });
});

describe('object redaction', () => {
  it('redacts nested keys, scrubs strings in arrays, and does not mutate the input', () => {
    const input = {
      tenantId: 't1',
      user: { email: 'a@b.example', displayName: 'A', credentials: { password: 'x' } },
      notes: ['call a@b.example', 'fine'],
      count: 3,
    };
    const out = redactObject(input);
    expect(out).toEqual({
      tenantId: 't1',
      user: { email: REDACTED, displayName: 'A', credentials: REDACTED },
      notes: ['call [email]', 'fine'],
      count: 3,
    });
    expect(input.user.email).toBe('a@b.example');
  });

  it('survives cycles, deep trees, binary values and keeps Errors for the serializer', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    const err = new Error('boom');
    const out = redactObject({
      cyclic,
      buf: Buffer.from('secret'),
      err,
      deep: { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } },
    });
    expect((out.cyclic as Record<string, unknown>).self).toBe('[circular]');
    expect(out.buf).toBe('[binary]');
    expect(out.err).toBe(err);
    expect(JSON.stringify(out.deep)).toContain('[max-depth]');
  });

  it('honours extra allowed keys', () => {
    expect(
      redactObject({ pinOrdinal: 1, email: 'a@b.example' }, { allowKeys: ['email'] }).email,
    ).toBe('[email]');
  });
});

describe('attribute redaction', () => {
  it('mutates flat attribute bags in place', () => {
    const attributes: Record<string, unknown> = {
      'http.route': '/v1/users',
      'http.request.header.authorization': 'Bearer abcdef0123456789',
      'user.email': 'a@b.example',
      'customer.note': 'refund for a@b.example',
      tags: ['x', 'y@z.example'],
      count: 2,
    };
    redactAttributesInPlace(attributes);
    expect(attributes).toEqual({
      'http.route': '/v1/users',
      'http.request.header.authorization': REDACTED,
      'user.email': REDACTED,
      'customer.note': 'refund for [email]',
      tags: ['x', '[email]'],
      count: 2,
    });
  });
});
