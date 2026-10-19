import { describe, expect, it } from 'vitest';

import { hashRequest } from './idempotency.interceptor.js';

describe('hashRequest', () => {
  it('is stable across key order and tolerant of decimals', () => {
    const a = hashRequest({
      method: 'POST',
      path: '/v1/x',
      query: { b: '1', a: '2' },
      body: { z: 1.5, y: [1, 2] },
    });
    const b = hashRequest({
      method: 'POST',
      path: '/v1/x',
      query: { a: '2', b: '1' },
      body: { y: [1, 2], z: 1.5 },
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the body or path changes', () => {
    const base = hashRequest({ method: 'POST', path: '/v1/x', query: {}, body: { a: 1 } });
    expect(hashRequest({ method: 'POST', path: '/v1/x', query: {}, body: { a: 2 } })).not.toBe(
      base,
    );
    expect(hashRequest({ method: 'POST', path: '/v1/y', query: {}, body: { a: 1 } })).not.toBe(
      base,
    );
    expect(hashRequest({ method: 'POST', path: '/v1/x', query: {}, body: undefined })).not.toBe(
      base,
    );
  });
});
