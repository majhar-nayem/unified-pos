/**
 * Permission catalog, limit keys and system roles for Phase 1 F1 (docs/01-system-architecture.md §6.3).
 * The API seeds `identity.permissions` / `identity.roles` from this file; clients use it to label UI.
 */
import type { LimitValue, PermissionKey } from './index.js';

export interface PermissionDefinition {
  readonly key: PermissionKey;
  readonly module: string;
  readonly description: string;
  /** Requires MFA / confirmation (identity.permissions.is_sensitive). */
  readonly isSensitive: boolean;
}

function perm(
  module: string,
  key: PermissionKey,
  description: string,
  isSensitive = false,
): PermissionDefinition {
  return { key, module, description, isSensitive };
}

export const PERMISSIONS: readonly PermissionDefinition[] = [
  // tenancy
  perm('tenancy', 'tenancy.tenant.view', 'View tenant profile and settings'),
  perm('tenancy', 'tenancy.org_unit.view', 'View the organisation hierarchy'),
  perm('tenancy', 'tenancy.org_unit.manage', 'Create, update and reparent org units'),
  perm('tenancy', 'tenancy.legal_entity.manage', 'Create and update legal entities'),
  perm('tenancy', 'tenancy.location.view', 'View locations'),
  perm('tenancy', 'tenancy.location.manage', 'Create and update locations'),
  perm('tenancy', 'tenancy.department.manage', 'Create and update departments'),
  perm('tenancy', 'tenancy.register.view', 'View registers'),
  perm('tenancy', 'tenancy.register.manage', 'Create and update registers'),
  perm('tenancy', 'tenancy.business_day.open', 'Open a business day at a location'),
  perm('tenancy', 'tenancy.business_day.close', 'Close a business day at a location'),
  perm('tenancy', 'tenancy.admin', 'Full tenancy administration', true),
  // config
  perm('config', 'config.view', 'View resolved and scoped configuration'),
  perm('config', 'config.edit', 'Change configuration at a scope'),
  perm('config', 'config.admin', 'Full configuration administration', true),
  // identity
  perm('identity', 'identity.user.view', 'View users'),
  perm('identity', 'identity.user.manage', 'Create, update, suspend and deactivate users'),
  perm('identity', 'identity.user.invite', 'Invite users by email'),
  perm('identity', 'identity.credential.manage', 'Reset passwords and revoke credentials', true),
  perm('identity', 'identity.pin.set', 'Set a per-location POS PIN'),
  perm('identity', 'identity.session.revoke', 'Revoke active sessions'),
  perm('identity', 'identity.admin', 'Full identity administration', true),
  // access
  perm('access', 'access.role.view', 'View roles and their permissions'),
  perm('access', 'access.role.manage', 'Create, clone and edit roles', true),
  perm('access', 'access.assignment.view', 'View role assignments'),
  perm('access', 'access.assignment.grant', 'Grant role assignments', true),
  perm('access', 'access.assignment.revoke', 'Revoke role assignments', true),
  perm('access', 'access.limit.manage', 'Edit ABAC limits on roles and assignments'),
  perm('access', 'access.api_client.manage', 'Create and revoke API clients'),
  perm('access', 'access.admin', 'Full access administration', true),
  // approvals
  perm('approvals', 'approvals.request', 'Request an approval for an over-limit action'),
  perm('approvals', 'approvals.approve', 'Approve or reject approval requests', true),
  perm('approvals', 'approvals.view', 'View approval requests'),
  // audit
  perm('audit', 'audit.view', 'View the audit log'),
  perm('audit', 'audit.verify', 'Verify the audit hash chain'),
  perm('audit', 'audit.export', 'Export audit records', true),
  perm('audit', 'audit.admin', 'Full audit administration', true),
  // devices
  perm('devices', 'devices.view', 'View devices'),
  perm('devices', 'devices.enroll', 'Issue enrollment codes and enroll devices'),
  perm('devices', 'devices.revoke', 'Revoke or wipe devices', true),
  perm('devices', 'devices.admin', 'Full device administration', true),
  // catalog (F2)
  perm(
    'catalog',
    'catalog.view',
    'View categories, items, variants, barcodes, units, modifiers, menus, suppliers',
  ),
  perm(
    'catalog',
    'catalog.item.manage',
    'Create and update categories, items, variants, barcodes, units and components',
  ),
  perm(
    'catalog',
    'catalog.modifier.manage',
    'Create and update modifier groups, modifiers and item links',
  ),
  perm('catalog', 'catalog.menu.manage', 'Create and edit menus, sections and assignments'),
  perm('catalog', 'catalog.menu.publish', 'Publish menus to devices'),
  perm('catalog', 'catalog.availability.manage', 'Mark items unavailable (86 list) at a location'),
  perm('catalog', 'catalog.supplier.manage', 'Create and update suppliers and supplier items'),
  perm('catalog', 'catalog.import', 'Import items, variants and barcodes from CSV'),
  // pricing (F2: tax rules are read with catalog.view; F3 adds price lists and promotions)
  perm('pricing', 'pricing.tax.manage', 'Create and update tax classes and tax rules', true),
  perm(
    'pricing',
    'pricing.admin',
    'Full pricing administration (price lists, promotions, coupons)',
    true,
  ),
  // finance (placeholders until F-finance)
  perm('finance', 'finance.reports.view', 'View financial reports'),
  perm('finance', 'finance.admin', 'Full finance administration', true),
  // orders (ABAC demo keys; the orders slice extends these)
  perm('orders', 'orders.discount.apply', 'Apply a discount to an order'),
  perm('orders', 'orders.refund.create', 'Create a refund'),
  perm('orders', 'orders.void', 'Void an order', true),
  // orders (F4)
  perm('orders', 'orders.view', 'View orders, their events and receipts'),
  perm(
    'orders',
    'orders.create',
    'Create and edit orders: lines, charges, suspend, resume, place, split and merge checks',
  ),
  perm('orders', 'orders.line.void', 'Void a line of a placed order', true),
  perm('orders', 'orders.price.override', 'Sell a line at a price other than the list price'),
  perm('orders', 'orders.receipt.reprint', 'Reprint a receipt that was already issued'),
  // payments (F5; keys mirror PAYMENT_PERMISSIONS in @pos/contracts)
  perm('payments', 'payments.view', 'View payment intents, attempts, events and refunds'),
  perm('payments', 'payments.intent.create', 'Take payments at a register (create and submit intents, cash tenders)'),
  perm('payments', 'payments.intent.manage', 'Capture, cancel, reverse intents and resolve offline outcomes', true),
  perm('payments', 'payments.provider.manage', 'Configure payment provider accounts', true),
  perm('payments', 'payments.terminal.manage', 'Pair, assign and retire payment terminals', true),
  perm('payments', 'payments.settlement.manage', 'Import settlements and manage disputes', true),
  perm('payments', 'payments.reconcile.manage', 'Resolve reconciliation exceptions', true),
];

export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map((p) => p.key);

export type LimitValueType = 'number' | 'boolean' | 'string' | 'string[]';

export interface LimitKeyDefinition {
  readonly key: string;
  readonly type: LimitValueType;
  readonly description: string;
}

export const LIMIT_KEYS: readonly LimitKeyDefinition[] = [
  {
    key: 'orders.discount.max_percent',
    type: 'number',
    description: 'Maximum discount percent that may be applied without approval',
  },
  {
    key: 'orders.refund.max_minor',
    type: 'number',
    description: 'Maximum refund amount (minor units) without approval',
  },
  {
    key: 'orders.price_override.allowed_categories',
    type: 'string[]',
    description: 'Catalog categories whose prices may be overridden',
  },
];

export interface SystemRoleDefinition {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly permissions: PermissionKey[];
  readonly limits?: Record<string, LimitValue>;
}

const ALL = PERMISSION_KEYS;
const byPrefix = (prefix: string): PermissionKey[] => ALL.filter((k) => k.startsWith(prefix));
const bySuffix = (suffix: string): PermissionKey[] => ALL.filter((k) => k.endsWith(suffix));

const ORDERS = byPrefix('orders.');
const APPROVALS = byPrefix('approvals.');
const PAYMENTS = byPrefix('payments.');
const PAYMENTS_FLOOR: readonly PermissionKey[] = ['payments.view', 'payments.intent.create'];

export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  {
    key: 'tenant_owner',
    name: 'Tenant owner',
    description: 'Unrestricted access to everything in the tenant',
    permissions: [...ALL],
  },
  {
    key: 'admin',
    name: 'Administrator',
    description: 'Administers tenancy, identity, access, devices and configuration',
    permissions: ALL.filter((k) => k !== 'finance.admin'),
  },
  {
    key: 'finance',
    name: 'Finance',
    description: 'Financial reporting, audit review and approvals',
    permissions: [
      ...byPrefix('finance.'),
      'audit.view',
      'audit.export',
      ...APPROVALS,
      'payments.view',
      'payments.settlement.manage',
      'payments.reconcile.manage',
    ],
  },
  {
    key: 'store_manager',
    name: 'Store manager',
    description: 'Runs a location: business days, staff PINs, approvals, devices and orders',
    permissions: [
      'tenancy.tenant.view',
      'tenancy.org_unit.view',
      'tenancy.location.view',
      'tenancy.register.view',
      'tenancy.business_day.open',
      'tenancy.business_day.close',
      'identity.user.view',
      'identity.pin.set',
      'access.assignment.view',
      ...APPROVALS,
      'devices.view',
      'devices.enroll',
      ...ORDERS,
      ...PAYMENTS,
    ],
    limits: { 'orders.discount.max_percent': 30, 'orders.refund.max_minor': 50000 },
  },
  {
    key: 'shift_supervisor',
    name: 'Shift supervisor',
    description: 'Approves over-limit actions on the floor and handles orders',
    permissions: [
      'approvals.approve',
      'approvals.view',
      ...ORDERS,
      ...PAYMENTS_FLOOR,
      'payments.intent.manage',
    ],
    limits: { 'orders.discount.max_percent': 15, 'orders.refund.max_minor': 20000 },
  },
  {
    key: 'cashier',
    name: 'Cashier',
    description: 'Sells at a register and requests approval when over limit',
    permissions: [
      'orders.view',
      'orders.create',
      'orders.discount.apply',
      'approvals.request',
      ...PAYMENTS_FLOOR,
    ],
    limits: { 'orders.discount.max_percent': 10 },
  },
  {
    key: 'server',
    name: 'Server',
    description: 'Takes orders at tables and requests approval when over limit',
    permissions: [
      'orders.view',
      'orders.create',
      'orders.discount.apply',
      'approvals.request',
      ...PAYMENTS_FLOOR,
    ],
    limits: { 'orders.discount.max_percent': 10 },
  },
  {
    key: 'kitchen',
    name: 'Kitchen',
    description: 'Kitchen display operator (no Phase 1 F1 permissions)',
    permissions: [],
  },
  {
    key: 'readonly_auditor',
    name: 'Read-only auditor',
    description: 'Reads everything, changes nothing',
    permissions: Array.from(new Set<PermissionKey>([...bySuffix('.view'), 'audit.view'])),
  },
];

export const SYSTEM_ROLE_KEYS: readonly string[] = SYSTEM_ROLES.map((r) => r.key);
