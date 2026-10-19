import type { PermissionKey } from '@pos/auth';

export interface NavItem {
  href: string;
  label: string;
  /** Visible when the principal holds ANY of these keys (same keys the API route contract names). */
  anyOf: readonly PermissionKey[];
  group: 'Overview' | 'Organisation' | 'People' | 'Operations' | 'Governance';
}

/**
 * Navigation is derived from the same permission keys the API enforces (docs/03 §5 F8): an item
 * shows when the principal holds the view permission of the page's list endpoint. The server stays
 * the authority; this only avoids dead links.
 */
export const NAV: readonly NavItem[] = [
  { href: '/', label: 'Home', anyOf: [], group: 'Overview' },
  { href: '/account', label: 'My account', anyOf: [], group: 'Overview' },
  {
    href: '/organisation',
    label: 'Organisation tree',
    anyOf: ['tenancy.org_unit.view'],
    group: 'Organisation',
  },
  {
    href: '/legal-entities',
    label: 'Legal entities',
    anyOf: ['tenancy.org_unit.view'],
    group: 'Organisation',
  },
  {
    href: '/locations',
    label: 'Locations',
    anyOf: ['tenancy.location.view'],
    group: 'Organisation',
  },
  {
    href: '/departments',
    label: 'Departments',
    anyOf: ['tenancy.location.view'],
    group: 'Organisation',
  },
  {
    href: '/registers',
    label: 'Registers',
    anyOf: ['tenancy.register.view'],
    group: 'Organisation',
  },
  { href: '/users', label: 'Users & invitations', anyOf: ['identity.user.view'], group: 'People' },
  { href: '/roles', label: 'Roles & assignments', anyOf: ['access.role.view'], group: 'People' },
  { href: '/approvals', label: 'Approvals', anyOf: ['approvals.view'], group: 'Operations' },
  { href: '/devices', label: 'Devices', anyOf: ['devices.view'], group: 'Operations' },
  { href: '/config', label: 'Configuration', anyOf: ['config.view'], group: 'Governance' },
  { href: '/audit', label: 'Audit log', anyOf: ['audit.view'], group: 'Governance' },
];

export const NAV_GROUPS = [
  'Overview',
  'Organisation',
  'People',
  'Operations',
  'Governance',
] as const;

export function pageAllowed(pathname: string, has: (k: PermissionKey) => boolean): boolean {
  const item = [...NAV]
    .sort((a, b) => b.href.length - a.href.length)
    .find((n) => (n.href === '/' ? pathname === '/' : pathname.startsWith(n.href)));
  if (!item || item.anyOf.length === 0) return true;
  return item.anyOf.some(has);
}
