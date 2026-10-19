import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  UNAUTHENTICATED_EVENT,
  api,
  apiRaw,
  buildQuery,
  describeError,
  flattenValidationDetails,
} from './client';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fn = vi.fn(
    async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('api client', () => {
  it('sends JSON, If-Match and an idempotency key through the same-origin proxy', async () => {
    const fn = stubFetch(201, { id: 'x' }, { etag: '"4"' });
    const res = await apiRaw<{ id: string }>('/locations', {
      method: 'POST',
      body: { a: 1 },
      ifMatch: 3,
      idempotent: true,
    });
    expect(res).toMatchObject({ data: { id: 'x' }, status: 201, etag: 4, replayed: false });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/locations');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['if-match']).toBe('"3"');
    expect(headers['idempotency-key']).toMatch(/.{8,}/);
    expect(init.credentials).toBe('same-origin');
  });

  it('builds query strings without empty values', () => {
    expect(buildQuery({ a: 'x', b: undefined, c: '', d: 0, e: false })).toBe('?a=x&d=0&e=false');
    expect(buildQuery({})).toBe('');
  });

  it('throws ApiError with code, message and details from the error envelope', async () => {
    stubFetch(422, {
      error: { code: 'VALIDATION_FAILED', message: 'bad', details: { x: 1 }, correlationId: 'c1' },
    });
    await expect(api('/x')).rejects.toMatchObject({
      status: 422,
      code: 'VALIDATION_FAILED',
      message: 'bad',
      details: { x: 1 },
      correlationId: 'c1',
    });
  });

  it('announces a lost session on 401 so the shell can redirect', async () => {
    stubFetch(401, { error: { code: 'SESSION_EXPIRED', message: 'Sign in again' } });
    const listener = vi.fn();
    window.addEventListener(UNAUTHENTICATED_EVENT, listener);
    await expect(api('/x')).rejects.toBeInstanceOf(ApiError);
    window.removeEventListener(UNAUTHENTICATED_EVENT, listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('handles 204 and non-JSON error bodies', async () => {
    stubFetch(204, undefined);
    await expect(api('/x', { method: 'DELETE' })).resolves.toBeUndefined();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 })),
    );
    await expect(api('/x')).rejects.toMatchObject({ status: 502, code: 'HTTP_502' });
  });

  it('describes errors for people', () => {
    expect(describeError(new ApiError(403, 'FORBIDDEN', 'x'))).toMatch(/permission/);
    expect(describeError(new ApiError(404, 'NOT_FOUND', 'x'))).toMatch(/outside your scope/);
    expect(describeError(new ApiError(412, 'VERSION_CONFLICT', 'x'))).toMatch(/Someone else/);
    expect(describeError(new ApiError(500, 'X', 'Internal error'))).toBe('Internal error');
    expect(describeError('weird')).toBe('Something went wrong');
  });

  it('flattens zod treeifyError details from every part of the request', () => {
    const details = {
      body: {
        errors: [],
        properties: {
          name: { errors: ['Too small'] },
          address: { errors: [], properties: { city: { errors: ['Required'] } } },
          lines: {
            errors: [],
            items: [{ errors: [], properties: { qty: { errors: ['Must be positive'] } } }],
          },
        },
      },
      value: ['must be <= 20'],
      key: 'unknown key',
    };
    expect(flattenValidationDetails(details)).toEqual({
      name: 'Too small',
      'address.city': 'Required',
      'lines[0].qty': 'Must be positive',
      value: 'must be <= 20',
      key: 'unknown key',
    });
    expect(flattenValidationDetails(null)).toEqual({});
  });
});
