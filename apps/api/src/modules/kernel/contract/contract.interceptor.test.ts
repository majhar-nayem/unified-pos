import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PreconditionRequiredError, ValidationError } from '../errors/errors.js';
import type { RouteContract } from './contract.js';
import { validateRequest } from './contract.interceptor.js';

const contract: RouteContract = {
  operationId: 'test.op',
  params: z.object({ locationId: z.uuid() }),
  query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
  body: z.object({ name: z.string().min(1), code: z.string().regex(/^[a-z0-9-]+$/) }),
  concurrency: 'if-match',
};

const req = (
  overrides: Partial<{
    params: unknown;
    query: unknown;
    body: unknown;
    headers: Record<string, string>;
  }> = {},
) => ({
  params: { locationId: '0190f8a0-0000-7000-8000-000000000001' },
  query: {},
  body: { name: 'Shop', code: 'shop-1' },
  header: (name: string) => ({ 'if-match': '"4"', ...overrides.headers })[name.toLowerCase()],
  ...overrides,
});

describe('validateRequest', () => {
  it('parses every part and applies defaults and coercions', () => {
    const out = validateRequest(contract, req({ query: { limit: '5' } }));
    expect(out.query).toEqual({ limit: 5 });
    expect(out.expectedVersion).toBe(4);
  });

  it('returns 422 with issue paths for every failing part', () => {
    expect.assertions(3);
    try {
      validateRequest(
        contract,
        req({ params: { locationId: 'nope' }, body: { name: '', code: 'BAD CODE' } }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const details = (error as ValidationError).details as Record<
        string,
        { properties?: Record<string, unknown> }
      >;
      expect(Object.keys(details.params!.properties ?? {})).toEqual(['locationId']);
      expect(Object.keys(details.body!.properties ?? {}).sort()).toEqual(['code', 'name']);
    }
  });

  it('requires If-Match when the contract declares optimistic concurrency', () => {
    expect(() => validateRequest(contract, req({ headers: { 'if-match': '' } }))).toThrow(
      PreconditionRequiredError,
    );
    expect(
      validateRequest(contract, req({ headers: { 'if-match': 'W/"7"' } })).expectedVersion,
    ).toBe(7);
    expect(
      validateRequest({ ...contract, concurrency: undefined }, req({ headers: { 'if-match': '' } }))
        .expectedVersion,
    ).toBeUndefined();
  });

  it('treats a missing body as undefined so a required body schema fails cleanly', () => {
    expect(() => validateRequest(contract, req({ body: undefined }))).toThrow(ValidationError);
  });
});
