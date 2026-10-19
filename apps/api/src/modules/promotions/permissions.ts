import type { PermissionKey } from '@pos/auth';

/**
 * Permissions the pricing module checks. The catalog in @pos/auth has no price-list or promotion
 * keys yet, so reads and the preview ride on `catalog.view` (cashiers and managers have it) and
 * every write on `pricing.admin` (administrators and tenant owners; MFA-gated). When fine-grained
 * keys such as pricing.promotion.manage land in the catalog, only this file changes.
 */
export const PRICING_PERMISSIONS = {
  view: 'catalog.view',
  preview: 'catalog.view',
  manage: 'pricing.admin',
} as const satisfies Record<string, PermissionKey>;
