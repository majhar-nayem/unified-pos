import { createHash } from 'node:crypto';

import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import {
  canonicalJson,
  completeIdempotencyKey,
  type IdempotencyKeyRef,
  type Pool,
  releaseIdempotencyKey,
  reserveIdempotencyKey,
  runInTenantTransaction,
} from '@pos/db';
import type { Request, Response } from 'express';
import { type Observable, from, of, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';

import { isOperator } from '../auth/authenticator.js';
import { getContract } from '../contract/contract.js';
import { PG_POOL } from '../database.module.js';
import { BadRequestError, ConflictError, ValidationError } from '../errors/errors.js';
import { RequestContextService } from '../request-context.js';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const REPLAYED_HEADER = 'idempotency-replayed';
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Idempotency filter (docs/01 §5.1 step 6). Two phases: reserve the key in its own transaction,
 * run the handler (which commits its own unit of work), then store status + body. Same key with a
 * different request hash → 422; still running → 409; completed → replay with Idempotency-Replayed.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly context: RequestContextService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  intercept(execution: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = execution.switchToHttp().getRequest<Request>();
    const res = execution.switchToHttp().getResponse<Response>();
    const contract = getContract(this.reflector, execution.getHandler());
    const header = req.header(IDEMPOTENCY_HEADER);
    const ctx = this.context.current();
    const principal = ctx?.principal;

    if (!header) {
      if (contract?.idempotent && req.method === 'POST') {
        throw new BadRequestError(
          'IDEMPOTENCY_KEY_REQUIRED',
          'This operation requires an Idempotency-Key header',
        );
      }
      return next.handle();
    }
    if (!KEY_PATTERN.test(header))
      throw new BadRequestError(
        'IDEMPOTENCY_KEY_INVALID',
        'Idempotency-Key must be 8-128 URL-safe characters',
      );
    if (!principal || isOperator(principal) || !ctx?.tenantId) return next.handle(); // no tenant: nothing to key on

    const tenantId = ctx.tenantId;
    const ref: IdempotencyKeyRef = {
      scope: `${principal.kind}:${principal.subjectId}:${contract?.operationId ?? `${req.method} ${req.route?.path ?? req.path}`}`,
      key: header,
    };
    const requestHash = hashRequest(req);
    const successStatus =
      this.reflector.get<number | undefined>(HTTP_CODE_METADATA, execution.getHandler()) ??
      contract?.status ??
      (req.method === 'POST' ? 201 : 200);

    return from(
      runInTenantTransaction(this.pool, tenantId, (uow) =>
        reserveIdempotencyKey(uow.db, ref, requestHash),
      ),
    ).pipe(
      mergeMap((reservation) => {
        switch (reservation.outcome) {
          case 'replay':
            res.status(reservation.status);
            res.setHeader(REPLAYED_HEADER, 'true');
            return of(reservation.body);
          case 'mismatch':
            throw new ValidationError(
              { idempotencyKey: 'reused with a different request' },
              'Idempotency-Key was already used for a different request',
            );
          case 'in_flight':
            throw new ConflictError(
              'IDEMPOTENCY_IN_FLIGHT',
              'A request with this Idempotency-Key is still being processed',
            );
          case 'reserved':
            return next.handle().pipe(
              mergeMap((body) =>
                from(
                  runInTenantTransaction(this.pool, tenantId, (uow) =>
                    completeIdempotencyKey(uow.db, ref, {
                      status: res.statusCode || successStatus,
                      body: body ?? null,
                    }),
                  ),
                ).pipe(mergeMap(() => of(body))),
              ),
              catchError((error: unknown) =>
                from(
                  runInTenantTransaction(this.pool, tenantId, (uow) =>
                    releaseIdempotencyKey(uow.db, ref),
                  ),
                ).pipe(mergeMap(() => throwError(() => error))),
              ),
            );
        }
      }),
    );
  }
}

export function hashRequest(req: {
  method: string;
  path: string;
  query: unknown;
  body: unknown;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        method: req.method,
        path: req.path,
        query: req.query ?? {},
        body: normalise(req.body),
      }),
    )
    .digest('hex');
}

/** Bodies may legitimately contain decimals; hash their JSON text form instead of rejecting them. */
function normalise(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(
    JSON.stringify(value, (_k, v) =>
      typeof v === 'number' && !Number.isSafeInteger(v) ? String(v) : v,
    ),
  );
}
