import { describe, expect, it } from 'vitest';

import { canonicalJson } from './canonical.js';

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { z: [1, { y: 2, x: undefined }], c: null } })).toBe(
      '{"a":{"c":null,"z":[1,{"y":2}]},"b":1}',
    );
  });

  it('is stable for equal objects with different key order', () => {
    expect(canonicalJson({ a: 1, b: 'x' })).toBe(canonicalJson({ b: 'x', a: 1 }));
  });

  it('serialises dates as ISO strings and bytes as base64', () => {
    expect(canonicalJson({ at: new Date('2026-10-18T03:00:00.123Z') })).toBe(
      '{"at":"2026-10-18T03:00:00.123Z"}',
    );
    expect(canonicalJson(new Uint8Array([1, 2, 3]))).toBe('"AQID"');
  });

  it('rejects values that do not survive a jsonb round trip', () => {
    expect(() => canonicalJson({ rate: 0.1 })).toThrow(/safe integer/);
    expect(() => canonicalJson({ n: -0 })).toThrow(/safe integer/);
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/safe integer/);
    expect(() => canonicalJson({ n: 10n })).toThrow(/bigint/);
    expect(() => canonicalJson({ n: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/safe integer/);
  });

  it('keeps array order and treats undefined array items as null', () => {
    expect(canonicalJson([3, undefined, 1])).toBe('[3,null,1]');
  });
});
