import type {
  AuthenticatedPrincipal,
  AuthenticationRequest,
  Authenticator,
} from '../auth/authenticator.js';

/**
 * Deterministic authenticator for integration tests: `Authorization: Bearer test:<name>` resolves
 * to a registered principal. Bind it with `app.get(KernelPorts).bind({ authenticator })` after init.
 */
export class TestAuthenticator implements Authenticator {
  constructor(private readonly principals: Map<string, AuthenticatedPrincipal> = new Map()) {}

  register(name: string, principal: AuthenticatedPrincipal): string {
    this.principals.set(name, principal);
    return `test:${name}`;
  }

  async authenticate(request: AuthenticationRequest): Promise<AuthenticatedPrincipal | null> {
    const header = request.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    const match = value ? /^Bearer test:(.+)$/.exec(value) : null;
    if (!match) return null;
    return this.principals.get(match[1]!) ?? null;
  }
}
