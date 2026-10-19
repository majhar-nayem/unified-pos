import { Injectable } from '@nestjs/common';

import {
  type AuthenticatedPrincipal,
  type AuthenticationRequest,
  type Authenticator,
  ForbiddenError,
  UnauthorizedError,
  UnitOfWork,
} from '../../kernel/public/index.js';
import { PrincipalResolver } from '../access/principal-resolver.js';
import { TokenService } from '../crypto/tokens.js';
import { SessionsService } from '../sessions/sessions.service.js';

/**
 * Platform operators have no login flow yet (open decision: Keycloak vs managed IdP). Until then
 * AUTH_OPERATOR_TOKENS = "operatorId:token,operatorId:token" grants OperatorPrincipals for
 * provisioning; tokens must start with "op_".
 */
export function operatorTokensFromEnv(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of (env.AUTH_OPERATOR_TOKENS ?? '').split(',')) {
    const [operatorId, token] = entry.split(':').map((s) => s.trim());
    if (operatorId && token && token.startsWith('op_') && token.length >= 20)
      map.set(token, operatorId);
  }
  return map;
}

/**
 * Bearer token → verified claims → Principal. Session-backed kinds are checked for revocation;
 * a stale assignments version simply rebuilds the principal (the cache is keyed by version).
 * Full sessions whose roles now require MFA but were never stepped up get 403 MFA_REQUIRED.
 */
@Injectable()
export class JwtAuthenticator implements Authenticator {
  constructor(
    private readonly tokens: TokenService,
    private readonly resolver: PrincipalResolver,
    private readonly sessions: SessionsService,
    private readonly uow: UnitOfWork,
  ) {}

  private readonly operatorTokens = operatorTokensFromEnv();

  async authenticate(request: AuthenticationRequest): Promise<AuthenticatedPrincipal | null> {
    const header = request.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    const match = value ? /^Bearer\s+(.+)$/i.exec(value) : null;
    if (!match) return null;
    const operatorId = this.operatorTokens.get(match[1]!);
    if (operatorId) return { kind: 'operator', operatorId, tenantId: null };
    const claims = await this.tokens.verify(match[1]!);
    if (claims.sid) {
      const active = await this.uow.readAs(claims.tid, (db) =>
        this.sessions.isActive(db, claims.sid!),
      );
      if (!active) throw new UnauthorizedError('SESSION_REVOKED', 'Session is no longer active');
    }
    const { principal, mfaRequired } = await this.resolver.resolve(claims);
    if (mfaRequired && !principal.mfaVerified && (claims.knd === 'web' || claims.knd === 'pos')) {
      throw new ForbiddenError('MFA_REQUIRED', 'A second factor is required for this account');
    }
    return principal;
  }
}
