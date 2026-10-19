import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { PermissionKey, ScopeKind } from '@pos/auth';
import type { Request } from 'express';
import type { ZodType } from 'zod';

export const CONTRACT_KEY = 'kernel:contract';

/** Which path parameter (or query/body fields) names the scope the ScopeGuard checks. */
export type ScopeSpec =
  | { readonly kind: 'tenant' }
  | { readonly kind: Exclude<ScopeKind, 'tenant'>; readonly param: string }
  | {
      readonly kind: 'dynamic';
      readonly from: 'query' | 'body';
      /** Field holding the scope kind, or a fixed `scopeKind`. */
      readonly kindField?: string;
      readonly scopeKind?: Exclude<ScopeKind, 'tenant'>;
      readonly idField: string;
    };

/**
 * Route contract: zod schemas for params/query/body/response plus the metadata the pipeline and
 * the OpenAPI document need. Every handler declares one; the cross-tenant harness reads them back
 * from /v1/openapi.json.
 */
export interface RouteContract {
  readonly operationId: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly params?: ZodType;
  readonly query?: ZodType;
  readonly body?: ZodType;
  readonly response?: ZodType;
  /** Success status (default 200, or 201 for POST without an explicit status). */
  readonly status?: number;
  /** Documented permission; the service still calls AuthorizationService.assert itself. */
  readonly permission?: PermissionKey;
  readonly scope?: ScopeSpec;
  /** Requires an Idempotency-Key header on POST; enables replay. */
  readonly idempotent?: boolean;
  /** Requires If-Match with the resource version; VersionConflictError → 412. */
  readonly concurrency?: 'if-match';
  readonly public?: boolean;
  readonly operator?: boolean;
  /** Examples with `$fixture:<name>` placeholders, used by the cross-tenant harness. */
  readonly examples?: {
    readonly params?: Readonly<Record<string, string>>;
    readonly query?: Readonly<Record<string, string>>;
    readonly body?: unknown;
  };
}

export const Contract = (contract: RouteContract) => SetMetadata(CONTRACT_KEY, contract);

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export function getContract(reflector: Reflector, handler: Function): RouteContract | undefined {
  return reflector.get(CONTRACT_KEY, handler) as RouteContract | undefined;
}

export interface ValidatedRequest {
  params: unknown;
  query: unknown;
  body: unknown;
  expectedVersion?: number;
}

export type RequestWithValidation = Request & { validated?: ValidatedRequest };

function validated(execution: ExecutionContext): ValidatedRequest {
  const req = execution.switchToHttp().getRequest<RequestWithValidation>();
  if (!req.validated) throw new Error('ContractInterceptor did not run for this handler');
  return req.validated;
}

export const ValidBody = createParamDecorator(
  (_data: unknown, execution: ExecutionContext) => validated(execution).body,
);
export const ValidQuery = createParamDecorator(
  (_data: unknown, execution: ExecutionContext) => validated(execution).query,
);
export const ValidParams = createParamDecorator(
  (_data: unknown, execution: ExecutionContext) => validated(execution).params,
);
export const IfMatch = createParamDecorator(
  (_data: unknown, execution: ExecutionContext) => validated(execution).expectedVersion,
);
