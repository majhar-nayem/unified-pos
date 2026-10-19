import { Module } from '@nestjs/common';

import { TenancyModule } from '../tenancy/public/index.js';
import { FeatureFlagsService } from './feature-flags.service.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { ProvisioningController } from './provisioning.controller.js';
import { TenantProvisioningService } from './provisioning.service.js';

@Module({
  imports: [TenancyModule],
  controllers: [HealthController, ProvisioningController],
  providers: [HealthService, FeatureFlagsService, TenantProvisioningService],
  exports: [HealthService, FeatureFlagsService, TenantProvisioningService],
})
export class PlatformModule {}
