import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { LimitExceededError, NotFoundError, VersionConflictError } from './errors.js';
import { isPgError, toErrorBody } from './exception.filter.js';

function pgError(code: string, detail = 'Key (tenant_id)=(x) is not present in table "tenants".') {
  return Object.assign(new Error('db error'), {
    code,
    severity: 'ERROR',
    detail,
    constraint: 'fk_secret_name',
  });
}

describe('GlobalExceptionFilter mapping', () => {
  it('maps RLS and FK violations to 404 and unique violations to 409 without leaking pg detail', () => {
    for (const [code, status] of [
      ['42501', 404],
      ['23503', 404],
      ['22P02', 404],
      ['23505', 409],
      ['23514', 422],
      ['40001', 409],
    ] as const) {
      const { status: got, body } = toErrorBody(pgError(code), 'corr-1');
      expect(got).toBe(status);
      const text = JSON.stringify(body);
      expect(text).not.toContain('fk_secret_name');
      expect(text).not.toContain('is not present');
      expect(body.error.correlationId).toBe('corr-1');
    }
  });

  it('maps unknown pg errors and plain errors to 500 with a generic message', () => {
    expect(toErrorBody(pgError('XX000')).status).toBe(500);
    const { status, body } = toErrorBody(new Error('secret internal state'));
    expect(status).toBe(500);
    expect(body.error.message).toBe('Internal error');
  });

  it('maps DomainError subclasses with their status, code and details', () => {
    expect(toErrorBody(new NotFoundError())).toMatchObject({
      status: 404,
      body: { error: { code: 'NOT_FOUND' } },
    });
    expect(toErrorBody(new VersionConflictError(3, 4))).toMatchObject({
      status: 412,
      body: { error: { code: 'VERSION_CONFLICT', details: { expected: 3, actual: 4 } } },
    });
    const limit = toErrorBody(
      new LimitExceededError({
        key: 'orders.discount.max_percent',
        value: 10,
        attribute: 25,
        assignmentId: 'a1',
      }),
    );
    expect(limit).toMatchObject({
      status: 409,
      body: {
        error: {
          code: 'LIMIT_EXCEEDED',
          details: { key: 'orders.discount.max_percent', value: 10, attribute: 25 },
        },
      },
    });
  });

  it('passes Nest HttpExceptions through with a stable code', () => {
    expect(toErrorBody(new BadRequestException('bad json'))).toMatchObject({
      status: 400,
      body: { error: { code: 'BAD_REQUEST', message: 'bad json' } },
    });
  });

  it('recognises pg errors by shape only', () => {
    expect(isPgError(pgError('23505'))).toBe(true);
    expect(isPgError({ code: 'ENOTFOUND' })).toBe(false);
    expect(isPgError(new Error('x'))).toBe(false);
  });
});
