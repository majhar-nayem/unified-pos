import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { createLogger, type Logger } from '@pos/observability';
import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';

import { authenticateOnce } from '../auth/authenticate-once.js';
import { type AuthenticatedPrincipal, isOperator } from '../auth/authenticator.js';
import { REDIS } from '../database.module.js';
import { TooManyRequestsError } from '../errors/errors.js';
import { KernelPorts } from '../ports.js';
import { RequestContextService } from '../request-context.js';
import { RATE_LIMIT_CONFIG, type RateLimitConfig } from './rate-limit.config.js';
import { type BucketConfig, TOKEN_BUCKET_LUA, bucketTtlMs } from './token-bucket.js';

export interface RateLimitSubject {
  /** Redis key suffix. */
  readonly key: string;
  readonly bucket: BucketConfig;
  /** Internal POS traffic keeps working when Redis is down; everything else is refused. */
  readonly failOpen: boolean;
}

/** Internal POS token kinds (docs/01 §5.1: "internal POS fails open with alert"). */
const FAIL_OPEN_KINDS: ReadonlySet<string> = new Set(['pos', 'device']);

/** Pure: who is being limited and with which bucket. */
export function rateLimitSubject(
  principal: AuthenticatedPrincipal | null,
  ip: string | undefined,
  config: RateLimitConfig,
): RateLimitSubject {
  if (!principal)
    return { key: `ip:${ip ?? 'unknown'}`, bucket: config.anonymous, failOpen: false };
  if (isOperator(principal))
    return { key: `operator:${principal.operatorId}`, bucket: config.principal, failOpen: false };
  return {
    key: `${principal.tenantId}:${principal.kind}:${principal.subjectId}`,
    bucket: config.principal,
    failOpen: FAIL_OPEN_KINDS.has(principal.tokenKind),
  };
}

/**
 * Pipeline step 1 (docs/01 §5.1): Redis token bucket per tenant+principal, per IP for anonymous
 * requests. Registered as the first global guard; AuthGuard reuses the authentication result.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger: Logger;

  constructor(
    private readonly ports: KernelPorts,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(RATE_LIMIT_CONFIG) private readonly config: RateLimitConfig,
  ) {
    this.logger = createLogger({ service: 'api', mixin: RequestContextService.logFields });
  }

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    if (!this.config.enabled) return true;
    const req = execution.switchToHttp().getRequest<Request>();
    const res = execution.switchToHttp().getResponse<Response>();
    const principal = await authenticateOnce(this.ports, req);
    const subject = rateLimitSubject(principal, req.ip, this.config);
    const key = `${this.config.keyPrefix}:${subject.key}`;

    let decision: [number, number, number];
    try {
      decision = (await this.redis.eval(
        TOKEN_BUCKET_LUA,
        1,
        key,
        subject.bucket.capacity,
        subject.bucket.refillPerSecond,
        Date.now(),
        1,
        bucketTtlMs(subject.bucket),
      )) as [number, number, number];
    } catch (error) {
      if (subject.failOpen) {
        this.logger.warn(
          { err: error, key },
          'rate limiter unavailable; allowing internal POS request (fail open)',
        );
        return true;
      }
      this.logger.error({ err: error, key }, 'rate limiter unavailable; refusing request');
      res.setHeader('Retry-After', '1');
      throw new TooManyRequestsError(
        'RATE_LIMITER_UNAVAILABLE',
        'Rate limiting is unavailable; retry shortly',
      );
    }

    const [allowed, remaining, retryAfterMs] = decision;
    res.setHeader('X-RateLimit-Limit', String(subject.bucket.capacity));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    if (allowed === 1) return true;
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    throw new TooManyRequestsError('RATE_LIMITED', 'Too many requests', { retryAfterSeconds });
  }
}
