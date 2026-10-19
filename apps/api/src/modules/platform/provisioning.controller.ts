import { Controller, Post } from '@nestjs/common';
import { ProvisionTenantRequestSchema, TenantSchema } from '@pos/contracts';
import { z } from 'zod';

import { Contract, OperatorOnly, ValidBody } from '../kernel/public/index.js';
import { TenantProvisioningService } from './provisioning.service.js';

const ProvisionedTenantSchema = z.object({
  tenant: TenantSchema,
  rootOrgUnitId: z.string().uuid(),
  admin: z.object({
    userId: z.string().uuid(),
    email: z.string().email(),
    inviteToken: z.string(),
  }),
});

@Controller('tenants')
export class ProvisioningController {
  constructor(private readonly provisioning: TenantProvisioningService) {}

  @Post()
  @OperatorOnly()
  @Contract({
    operationId: 'platform.tenant.provision',
    summary: 'Provision a tenant (platform operators)',
    tags: ['platform'],
    body: ProvisionTenantRequestSchema,
    response: ProvisionedTenantSchema,
    operator: true,
    idempotent: true,
    examples: {
      body: {
        slug: 'acme-cafe',
        name: 'Acme Cafe',
        admin: { email: 'owner@acme.test', displayName: 'Acme Owner' },
      },
    },
  })
  provision(@ValidBody() body: z.infer<typeof ProvisionTenantRequestSchema>) {
    return this.provisioning.provision(body);
  }
}
