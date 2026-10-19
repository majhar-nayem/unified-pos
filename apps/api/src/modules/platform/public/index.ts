/**
 * Public surface of the `platform` module. Other modules and the app shell import ONLY from here.
 */
export { PlatformModule } from '../platform.module.js';
export { HealthService } from '../health.service.js';
export { FeatureFlagsService } from '../feature-flags.service.js';
export type { FlagContext } from '../feature-flags.service.js';
export { TenantProvisioningService, TENANT_SEEDERS } from '../provisioning.service.js';
export type { ProvisionedTenant, TenantSeeder } from '../provisioning.service.js';
