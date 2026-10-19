export { KernelModule } from '../kernel.module.js';
export { API_PREFIX } from '../kernel.constants.js';
export {
  RequestContextService,
  RequestContextMiddleware,
  CORRELATION_HEADER,
} from '../request-context.js';
export type { RequestContext, ResolvedScope } from '../request-context.js';
export { isOperator } from '../auth/authenticator.js';
export type {
  Authenticator,
  AuthenticatedPrincipal,
  AuthenticationRequest,
  OperatorPrincipal,
  TenantPrincipal,
} from '../auth/authenticator.js';
export { Public, OperatorOnly, AllowKinds } from '../auth/decorators.js';
export { AuthGuard } from '../auth/auth.guard.js';
export { RateLimitGuard, rateLimitSubject } from '../rate-limit/rate-limit.guard.js';
export type { RateLimitSubject } from '../rate-limit/rate-limit.guard.js';
export {
  RATE_LIMIT_CONFIG,
  RATE_LIMIT_DEFAULTS,
  RATE_LIMIT_DISABLED,
  rateLimitConfigFromEnv,
} from '../rate-limit/rate-limit.config.js';
export type { RateLimitConfig } from '../rate-limit/rate-limit.config.js';
export { takeToken, bucketTtlMs, TOKEN_BUCKET_LUA } from '../rate-limit/token-bucket.js';
export type { BucketConfig, BucketDecision, BucketState } from '../rate-limit/token-bucket.js';
export { NullAuthenticator } from '../auth/null-authenticator.js';
export { NullScopeResolver } from '../scope/null-scope-resolver.js';
export type { ScopeResolver, ExpandedScope } from '../scope/scope-resolver.js';
export { KernelPorts, NoopFirstAdminProvisioner } from '../ports.js';
export type { FirstAdminProvisioner, KernelPortBindings } from '../ports.js';
export { ScopeGuard, principalReaches } from '../scope/scope.guard.js';
export { AuthorizationService } from '../authz/authorization.service.js';
export type { Attributes } from '../authz/authorization.service.js';
export {
  Contract,
  ValidBody,
  ValidQuery,
  ValidParams,
  IfMatch,
  getContract,
} from '../contract/contract.js';
export type { RouteContract, ScopeSpec } from '../contract/contract.js';
export { ContractInterceptor } from '../contract/contract.interceptor.js';
export {
  IdempotencyInterceptor,
  IDEMPOTENCY_HEADER,
  REPLAYED_HEADER,
} from '../idempotency/idempotency.interceptor.js';
export { EtagInterceptor } from '../etag/etag.interceptor.js';
export * from '../errors/errors.js';
export { GlobalExceptionFilter } from '../errors/exception.filter.js';
export { buildOpenApiDocument } from '../openapi/openapi.builder.js';
export type { OpenApiDocument, OpenApiOperation } from '../openapi/openapi.builder.js';
export { DatabaseModule, PG_POOL, REDIS } from '../database.module.js';
export { TenantDirectory } from '../tenant-directory.js';
export type { TenantRecord } from '../tenant-directory.js';
export { UnitOfWork, actorFrom } from '../unit-of-work.js';
export { TestAuthenticator } from '../testing/test-authenticator.js';
