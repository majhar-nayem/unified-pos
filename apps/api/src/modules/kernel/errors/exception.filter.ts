import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import { createLogger, type Logger } from '@pos/observability';
import type { Response } from 'express';

import { RequestContextService } from '../request-context.js';
import { DomainError } from './errors.js';

/**
 * Postgres SQLSTATE → HTTP. Anything the caller is not allowed to see behaves as "does not exist";
 * constraint names and detail never leave the process (docs/01 §6.2 layer 4).
 */
export const PG_ERROR_STATUS: Readonly<Record<string, { status: number; code: string }>> = {
  '42501': { status: 404, code: 'NOT_FOUND' }, // insufficient_privilege (RLS WITH CHECK)
  '23503': { status: 404, code: 'NOT_FOUND' }, // foreign_key_violation (parent invisible to this tenant)
  '22P02': { status: 404, code: 'NOT_FOUND' }, // invalid_text_representation (bad uuid)
  '23505': { status: 409, code: 'CONFLICT' }, // unique_violation
  '23514': { status: 422, code: 'VALIDATION_FAILED' }, // check_violation
  '23502': { status: 422, code: 'VALIDATION_FAILED' }, // not_null_violation
  '40001': { status: 409, code: 'RETRY' }, // serialization_failure
  '40P01': { status: 409, code: 'RETRY' }, // deadlock_detected
  '23P01': { status: 409, code: 'CONFLICT' }, // exclusion_violation
};

interface PgLikeError {
  code: string;
  severity?: string;
}

export function isPgError(error: unknown): error is PgLikeError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    /^[0-9A-Z]{5}$/.test((error as { code: string }).code) &&
    'severity' in error
  );
}

export interface ErrorBody {
  error: { code: string; message: string; correlationId?: string; details?: unknown };
}

/** Pure mapping so it can be unit tested without Nest. */
export function toErrorBody(
  error: unknown,
  correlationId?: string,
): { status: number; body: ErrorBody } {
  const corr = correlationId ? { correlationId } : {};
  if (error instanceof DomainError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...corr,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      },
    };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const response = error.getResponse();
    const message =
      typeof response === 'string'
        ? response
        : ((response as { message?: unknown }).message ?? error.message);
    return {
      status,
      body: {
        error: {
          code: httpCode(status),
          message: Array.isArray(message) ? message.join('; ') : String(message),
          ...corr,
        },
      },
    };
  }
  if (isPgError(error)) {
    const mapped = PG_ERROR_STATUS[error.code];
    if (mapped) {
      return {
        status: mapped.status,
        body: { error: { code: mapped.code, message: defaultMessage(mapped.status), ...corr } },
      };
    }
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'Internal error', ...corr } } };
}

function httpCode(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'VALIDATION_FAILED';
    default:
      return `HTTP_${status}`;
  }
}

function defaultMessage(status: number): string {
  return status === 404
    ? 'Not found'
    : status === 409
      ? 'Conflict'
      : status === 422
        ? 'Invalid request'
        : 'Error';
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger: Logger;

  constructor(private readonly context: RequestContextService) {
    this.logger = createLogger({ service: 'api', mixin: RequestContextService.logFields });
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const ctx = this.context.current();
    const { status, body } = toErrorBody(exception, ctx?.correlationId);
    if (status >= 500) this.logger.error({ err: exception }, 'unhandled error');
    else this.logger.debug({ status, code: body.error.code }, 'request failed');
    res.status(status).json(body);
  }
}
