import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { z, type ZodType } from 'zod';

import { PreconditionRequiredError, ValidationError } from '../errors/errors.js';
import { getContract, type RequestWithValidation, type RouteContract } from './contract.js';

/** Validates params, query and body against the route contract (zod 4) → 422 with issue paths. */
@Injectable()
export class ContractInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(execution: ExecutionContext, next: CallHandler): Observable<unknown> {
    const contract = getContract(this.reflector, execution.getHandler());
    const req = execution.switchToHttp().getRequest<RequestWithValidation>();
    if (!contract) {
      req.validated = { params: req.params, query: req.query, body: req.body };
      return next.handle();
    }
    req.validated = validateRequest(contract, req);
    return next.handle();
  }
}

export function validateRequest(
  contract: RouteContract,
  req: { params: unknown; query: unknown; body: unknown; header(name: string): string | undefined },
): { params: unknown; query: unknown; body: unknown; expectedVersion?: number } {
  const issues: Record<string, unknown> = {};
  const params = parsePart('params', contract.params, req.params, issues);
  const query = parsePart('query', contract.query, req.query, issues);
  const body = parsePart('body', contract.body, req.body, issues);
  if (Object.keys(issues).length > 0) throw new ValidationError(issues);

  let expectedVersion: number | undefined;
  if (contract.concurrency === 'if-match') {
    const header = req.header('if-match');
    const match = header ? /^(?:W\/)?"?(\d+)"?$/.exec(header.trim()) : null;
    if (!match) throw new PreconditionRequiredError();
    expectedVersion = Number(match[1]);
  }
  return { params, query, body, ...(expectedVersion !== undefined ? { expectedVersion } : {}) };
}

function parsePart(
  name: string,
  schema: ZodType | undefined,
  value: unknown,
  issues: Record<string, unknown>,
): unknown {
  if (!schema) return value;
  const result = schema.safeParse(value ?? (name === 'body' ? undefined : {}));
  if (result.success) return result.data;
  issues[name] = z.treeifyError(result.error);
  return undefined;
}
