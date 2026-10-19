import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { TokenKind } from '@pos/auth';
import type { Request } from 'express';

import { NotFoundError, UnauthorizedError } from '../errors/errors.js';
import { KernelPorts } from '../ports.js';
import { RequestContextService } from '../request-context.js';
import { authenticateOnce } from './authenticate-once.js';
import { isOperator } from './authenticator.js';
import { ALLOW_KINDS_KEY, OPERATOR_ONLY_KEY, PUBLIC_KEY } from './decorators.js';

const DEFAULT_KINDS: readonly TokenKind[] = ['web', 'pos', 'device', 'api'];

/** AuthN (docs/01 §5.1 step 2) + tenant resolution from the verified token only (step 3). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly context: RequestContextService,
    private readonly ports: KernelPorts,
  ) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    const targets = [execution.getHandler(), execution.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets) === true;
    const req = execution.switchToHttp().getRequest<Request>();
    const ctx = this.context.require();

    const principal = await authenticateOnce(this.ports, req);
    if (!principal) {
      if (isPublic) return true;
      throw new UnauthorizedError();
    }
    ctx.principal = principal;
    (req as Request & { principal?: unknown }).principal = principal;

    const operatorOnly =
      this.reflector.getAllAndOverride<boolean>(OPERATOR_ONLY_KEY, targets) === true;
    if (isOperator(principal)) {
      if (!operatorOnly && !isPublic) throw new NotFoundError();
      return true;
    }
    if (operatorOnly) throw new NotFoundError();

    const allowed =
      this.reflector.getAllAndOverride<readonly TokenKind[]>(ALLOW_KINDS_KEY, targets) ??
      DEFAULT_KINDS;
    if (!allowed.includes(principal.tokenKind)) {
      if (isPublic) return true;
      throw new UnauthorizedError(
        'TOKEN_KIND_NOT_ALLOWED',
        `A ${principal.tokenKind} token cannot call this route`,
      );
    }
    ctx.tenantId = principal.tenantId;
    return true;
  }
}
