import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ProvisionTenantRequest, TenantDto } from '@pos/contracts';
import { newId, type TenantUnitOfWork } from '@pos/db';

import {
  KernelPorts,
  RequestContextService,
  UnitOfWork,
  actorFrom,
} from '../kernel/public/index.js';
import { TenantSkeletonService } from '../tenancy/public/index.js';

export interface ProvisionedTenant {
  readonly tenant: TenantDto;
  readonly rootOrgUnitId: string;
  readonly admin: { userId: string; email: string; inviteToken: string };
}

/** Seeders other slices register (F2: AU GST tax classes/rules). Run inside the provisioning transaction. */
export const TENANT_SEEDERS = Symbol('TENANT_SEEDERS');

export interface TenantSeeder {
  readonly name: string;
  seed(uow: TenantUnitOfWork): Promise<void>;
}

/**
 * Operator-only tenant provisioning: one transaction creates the tenant row (SECURITY DEFINER),
 * root org unit, first admin (identity port), audit entry and `tenant.provisioned` event.
 * The tenant id is generated first so the RLS context can be set before the row exists.
 */
@Injectable()
export class TenantProvisioningService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly skeleton: TenantSkeletonService,
    private readonly context: RequestContextService,
    private readonly ports: KernelPorts,
    @Optional() @Inject(TENANT_SEEDERS) private readonly seeders: readonly TenantSeeder[] = [],
  ) {}

  async provision(input: ProvisionTenantRequest): Promise<ProvisionedTenant> {
    const ctx = this.context.require();
    const actor = ctx.principal ? actorFrom(ctx.principal, ctx.ip) : { kind: 'system' as const };
    const tenantId = newId();
    return this.uow.runAs(tenantId, actor, async (uow) => {
      const { tenant, rootOrgUnitId } = await this.skeleton.create(uow, {
        tenantId,
        slug: input.slug,
        name: input.name,
        ...(input.region ? { region: input.region } : {}),
        ...(input.defaultCurrency ? { defaultCurrency: input.defaultCurrency } : {}),
        ...(input.defaultLocale ? { defaultLocale: input.defaultLocale } : {}),
        ...(input.defaultTimezone ? { defaultTimezone: input.defaultTimezone } : {}),
      });
      for (const seeder of this.seeders) await seeder.seed(uow);
      const admin = await this.ports.firstAdminProvisioner.createFirstAdmin(uow, {
        tenantId,
        email: input.admin.email,
        displayName: input.admin.displayName,
      });
      uow.audit({
        action: 'platform.tenant.provisioned',
        resourceKind: 'tenant',
        resourceId: tenantId,
        after: { slug: tenant.slug, name: tenant.name, rootOrgUnitId, adminUserId: admin.userId },
      });
      uow.emit({
        type: 'tenant.provisioned',
        aggregateKind: 'tenant',
        aggregateId: tenantId,
        aggregateVersion: 1,
        payload: {
          slug: tenant.slug,
          name: tenant.name,
          region: tenant.region,
          adminUserId: admin.userId,
        },
      });
      return {
        tenant,
        rootOrgUnitId,
        admin: { userId: admin.userId, email: input.admin.email, inviteToken: admin.inviteToken },
      };
    });
  }
}
