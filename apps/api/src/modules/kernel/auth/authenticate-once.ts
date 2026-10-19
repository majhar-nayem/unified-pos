import type { Request } from 'express';

import type { KernelPorts } from '../ports.js';
import type { AuthenticatedPrincipal } from './authenticator.js';

const results = new WeakMap<object, Promise<AuthenticatedPrincipal | null>>();

/**
 * The rate limiter runs ahead of AuthGuard yet keys authenticated callers by principal, so the
 * token is verified once per request and both guards share the outcome.
 */
export function authenticateOnce(
  ports: KernelPorts,
  req: Request,
): Promise<AuthenticatedPrincipal | null> {
  let pending = results.get(req);
  if (!pending) {
    pending = ports.authenticator.authenticate({ headers: req.headers, ip: req.ip });
    results.set(req, pending);
  }
  return pending;
}
