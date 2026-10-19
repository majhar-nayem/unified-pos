import type { ExceededLimit } from '@pos/auth';

/** Base class for errors that map to an HTTP status without leaking internals. */
export class DomainError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Out of scope and missing are the same thing to the caller (docs/01 §6.2). */
export class NotFoundError extends DomainError {
  constructor(message = 'Not found', details?: unknown) {
    super(404, 'NOT_FOUND', message, details);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(code = 'UNAUTHORIZED', message = 'Authentication required') {
    super(401, code, message);
  }
}

export class ForbiddenError extends DomainError {
  constructor(code = 'FORBIDDEN', message = 'Not permitted', details?: unknown) {
    super(403, code, message, details);
  }
}

export class ConflictError extends DomainError {
  constructor(code = 'CONFLICT', message = 'Conflict', details?: unknown) {
    super(409, code, message, details);
  }
}

export class ValidationError extends DomainError {
  constructor(details: unknown, message = 'Request validation failed') {
    super(422, 'VALIDATION_FAILED', message, details);
  }
}

export class PreconditionRequiredError extends DomainError {
  constructor(message = 'If-Match header is required') {
    super(428, 'PRECONDITION_REQUIRED', message);
  }
}

export class VersionConflictError extends DomainError {
  constructor(expected: number, actual?: number) {
    super(412, 'VERSION_CONFLICT', 'The resource was modified by someone else', {
      expected,
      actual,
    });
  }
}

/** Rate limit exceeded or the limiter itself is unavailable on a fail-closed route (429). */
export class TooManyRequestsError extends DomainError {
  constructor(code = 'RATE_LIMITED', message = 'Too many requests', details?: unknown) {
    super(429, code, message, details);
  }
}

export class LockedError extends DomainError {
  constructor(message = 'Locked', details?: unknown) {
    super(423, 'LOCKED', message, details);
  }
}

/** A permission limit was exceeded; identity turns this into an approval request. */
export class LimitExceededError extends DomainError {
  constructor(public readonly limit: ExceededLimit) {
    super(409, 'LIMIT_EXCEEDED', `Limit ${limit.key} exceeded`, {
      key: limit.key,
      value: limit.value,
      attribute: limit.attribute,
    });
  }
}

export class BadRequestError extends DomainError {
  constructor(code: string, message: string, details?: unknown) {
    super(400, code, message, details);
  }
}
