import { ConflictError, DomainError, NotFoundError } from '../kernel/public/index.js';
import { domain } from './domain.js';

/** Business-rule failures from the aggregate become the API's error shapes (404 / 409 / 422) with their rule code. */
export function mapRuleError(error: unknown): unknown {
  if (!(error instanceof domain.OrderRuleError)) return error;
  switch (error.kind) {
    case 'not_found':
      return error.code === 'LINE_NOT_FOUND' || error.code === 'CHECK_NOT_FOUND'
        ? new DomainError(404, error.code, error.message, error.details)
        : new NotFoundError(error.message, error.details);
    case 'conflict':
      return new ConflictError(error.code, error.message, error.details);
    case 'invalid':
      return new DomainError(422, error.code, error.message, error.details);
  }
}

/** Run a reducer (or any domain call); rule errors surface as API errors. */
export async function rules<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapRuleError(error);
  }
}
