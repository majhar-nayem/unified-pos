/** Public surface of the tenancy module. Other modules and the app shell import ONLY from here. */
export { TenancyModule } from '../tenancy.module.js';
export { HierarchyService, scopePath, expandScope } from '../hierarchy.service.js';
export { ConfigService, effectiveConfig } from '../config.service.js';
export { TenantSkeletonService } from '../tenant-skeleton.service.js';
export type { TenantSkeletonInput } from '../tenant-skeleton.service.js';
export { resolveNearest } from '../config.resolver.js';
