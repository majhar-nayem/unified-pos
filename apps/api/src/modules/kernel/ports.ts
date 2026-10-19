import { Injectable } from '@nestjs/common';
import type { TenantUnitOfWork } from '@pos/db';

import { type Authenticator } from './auth/authenticator.js';
import { NullAuthenticator } from './auth/null-authenticator.js';
import { NullScopeResolver } from './scope/null-scope-resolver.js';
import type { ScopeResolver } from './scope/scope-resolver.js';

/**
 * Port implemented by the identity module and consumed by platform tenant provisioning:
 * create the tenant's first administrator inside the provisioning transaction.
 */
export interface FirstAdminProvisioner {
  createFirstAdmin(
    uow: TenantUnitOfWork,
    input: { tenantId: string; email: string; displayName: string },
  ): Promise<{ userId: string; inviteToken: string }>;
}

export class NoopFirstAdminProvisioner implements FirstAdminProvisioner {
  async createFirstAdmin(): Promise<{ userId: string; inviteToken: string }> {
    throw new Error(
      'KernelPorts.firstAdminProvisioner is not bound; the identity module must provide it',
    );
  }
}

export interface KernelPortBindings {
  readonly authenticator: Authenticator;
  readonly scopeResolver: ScopeResolver;
  readonly firstAdminProvisioner: FirstAdminProvisioner;
}

/**
 * The kernel's outbound ports. Domain modules implement them; the composition root (AppModule)
 * binds them in onModuleInit, and tests bind stand-ins after app.init(). Guards and services
 * read the current binding on every call, so DI module scoping never shadows a binding.
 */
@Injectable()
export class KernelPorts implements KernelPortBindings {
  authenticator: Authenticator = new NullAuthenticator();
  scopeResolver: ScopeResolver = new NullScopeResolver();
  firstAdminProvisioner: FirstAdminProvisioner = new NoopFirstAdminProvisioner();

  bind(bindings: Partial<KernelPortBindings>): void {
    if (bindings.authenticator) this.authenticator = bindings.authenticator;
    if (bindings.scopeResolver) this.scopeResolver = bindings.scopeResolver;
    if (bindings.firstAdminProvisioner) this.firstAdminProvisioner = bindings.firstAdminProvisioner;
  }
}
