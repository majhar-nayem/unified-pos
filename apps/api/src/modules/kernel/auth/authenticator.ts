import type { Principal, TokenKind } from '@pos/auth';

/** Platform operator (platform.operators): no tenant, only @OperatorOnly() routes. */
export interface OperatorPrincipal {
  readonly kind: 'operator';
  readonly operatorId: string;
  readonly email?: string;
  readonly tenantId: null;
}

export type TenantPrincipal = Principal & { readonly tokenKind: TokenKind };

export type AuthenticatedPrincipal = TenantPrincipal | OperatorPrincipal;

export function isOperator(
  principal: AuthenticatedPrincipal | undefined,
): principal is OperatorPrincipal {
  return principal?.kind === 'operator';
}

export interface AuthenticationRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly ip?: string;
}

/**
 * Contract between the kernel and the identity module. The identity module binds the token
 * KernelPorts.authenticator to a JWT implementation; tests bind TestAuthenticator.
 */
export interface Authenticator {
  /** null = no credentials or invalid credentials (the guard answers 401). */
  authenticate(request: AuthenticationRequest): Promise<AuthenticatedPrincipal | null>;
}
