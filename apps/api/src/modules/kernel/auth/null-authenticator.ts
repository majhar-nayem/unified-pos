import type { AuthenticatedPrincipal, Authenticator } from './authenticator.js';

/** Default binding until the identity module provides a real one: every request is anonymous. */
export class NullAuthenticator implements Authenticator {
  async authenticate(): Promise<AuthenticatedPrincipal | null> {
    return null;
  }
}
