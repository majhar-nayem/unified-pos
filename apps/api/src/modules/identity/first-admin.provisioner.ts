import { Injectable } from '@nestjs/common';
import type { TenantUnitOfWork } from '@pos/db';

import type { FirstAdminProvisioner } from '../kernel/public/index.js';
import { AssignmentsService } from './access/assignments.service.js';
import { UsersService } from './users/users.service.js';

/** Creates the invited tenant owner during provisioning and grants the `tenant_owner` system role tenant-wide. */
@Injectable()
export class IdentityFirstAdminProvisioner implements FirstAdminProvisioner {
  constructor(
    private readonly users: UsersService,
    private readonly assignments: AssignmentsService,
  ) {}

  async createFirstAdmin(
    uow: TenantUnitOfWork,
    input: { tenantId: string; email: string; displayName: string },
  ): Promise<{ userId: string; inviteToken: string }> {
    const { user, inviteToken } = await this.users.inviteIn(uow, {
      email: input.email,
      displayName: input.displayName,
    });
    const role = await uow.db.maybeOne<{ id: string }>(
      "SELECT id FROM identity.roles WHERE tenant_id IS NULL AND key = 'tenant_owner'",
    );
    if (!role) throw new Error('System role tenant_owner is not seeded');
    await this.assignments.grantIn(uow, {
      userId: user.id,
      roleId: role.id,
      roleKey: 'tenant_owner',
      scope: { kind: 'tenant', id: input.tenantId },
      grantedBy: null,
      reason: 'tenant provisioning',
    });
    return { userId: user.id, inviteToken };
  }
}
