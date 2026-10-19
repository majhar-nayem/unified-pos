import { randomUUID } from 'node:crypto';

import type { Pool } from '@pos/db';

export interface TenantFixture {
  readonly tenantId: string;
  readonly legalEntityId: string;
  readonly slug: string;
}

/** Create a tenant and one legal entity with the superuser pool (RLS bypassed for fixtures). */
export async function createTenantFixture(admin: Pool, slug: string): Promise<TenantFixture> {
  const tenantId = randomUUID();
  const legalEntityId = randomUUID();
  await admin.query('INSERT INTO platform.tenants (id, slug, name) VALUES ($1, $2, $3)', [
    tenantId,
    slug,
    `Tenant ${slug}`,
  ]);
  await admin.query(
    'INSERT INTO tenancy.legal_entities (id, tenant_id, name, country_code) VALUES ($1, $2, $3, $4)',
    [legalEntityId, tenantId, `${slug} Pty Ltd`, 'AU'],
  );
  return { tenantId, legalEntityId, slug };
}

export interface HierarchyFixture extends TenantFixture {
  readonly rootOrgUnitId: string;
  readonly childOrgUnitId: string;
  /** Under the child org unit. */
  readonly locationId: string;
  /** Under the root org unit; the "other" location for out-of-scope tests. */
  readonly otherLocationId: string;
  readonly departmentId: string;
  readonly registerId: string;
  readonly otherRegisterId: string;
}

/**
 * tenant → root org unit (company) → child org unit (region) → location + department + register,
 * plus a second location (with its own register) directly under the root.
 */
export async function createHierarchyFixture(admin: Pool, slug: string): Promise<HierarchyFixture> {
  const tenant = await createTenantFixture(admin, slug);
  const ids = {
    rootOrgUnitId: randomUUID(),
    childOrgUnitId: randomUUID(),
    locationId: randomUUID(),
    otherLocationId: randomUUID(),
    departmentId: randomUUID(),
    registerId: randomUUID(),
    otherRegisterId: randomUUID(),
  };
  const t = tenant.tenantId;
  await admin.query(
    `INSERT INTO tenancy.org_units (id, tenant_id, parent_id, kind, code, name, legal_entity_id)
     VALUES ($1, $2, NULL, 'company', 'root', 'Root', $3)`,
    [ids.rootOrgUnitId, t, tenant.legalEntityId],
  );
  await admin.query(
    `INSERT INTO tenancy.org_units (id, tenant_id, parent_id, kind, code, name)
     VALUES ($1, $2, $3, 'region', 'nsw', 'New South Wales')`,
    [ids.childOrgUnitId, t, ids.rootOrgUnitId],
  );
  await admin.query(
    `INSERT INTO tenancy.locations (id, tenant_id, org_unit_id, code, name, kind, timezone, currency)
     VALUES ($1, $2, $3, 'syd-1', 'Sydney CBD', 'store', 'Australia/Sydney', 'AUD'),
            ($4, $2, $5, 'mel-1', 'Melbourne', 'restaurant', 'Australia/Melbourne', 'AUD')`,
    [ids.locationId, t, ids.childOrgUnitId, ids.otherLocationId, ids.rootOrgUnitId],
  );
  await admin.query(
    `INSERT INTO tenancy.departments (id, tenant_id, location_id, code, name, kind)
     VALUES ($1, $2, $3, 'front', 'Front of house', 'retail')`,
    [ids.departmentId, t, ids.locationId],
  );
  await admin.query(
    `INSERT INTO tenancy.registers (id, tenant_id, location_id, department_id, code, name)
     VALUES ($1, $2, $3, $4, 'R1', 'Register 1'),
            ($5, $2, $6, NULL, 'R1', 'Register 1')`,
    [ids.registerId, t, ids.locationId, ids.departmentId, ids.otherRegisterId, ids.otherLocationId],
  );
  return { ...tenant, ...ids };
}

export interface UserFixture {
  readonly userId: string;
  readonly email: string;
}

export async function createUserFixture(
  admin: Pool,
  tenantId: string,
  options: {
    email?: string;
    displayName?: string;
    status?: 'invited' | 'active' | 'suspended' | 'deactivated';
  } = {},
): Promise<UserFixture> {
  const userId = randomUUID();
  const email = options.email ?? `${userId.slice(0, 8)}@example.test`;
  await admin.query(
    'INSERT INTO identity.users (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, $5)',
    [userId, tenantId, email, options.displayName ?? 'Test User', options.status ?? 'active'],
  );
  return { userId, email };
}

export interface IdentityFixture {
  readonly userId: string;
  readonly roleId: string;
  readonly assignmentId: string;
  readonly apiClientId: string;
  readonly approvalId: string;
  readonly deviceId: string;
}

/** Tenant-level identity rows for a hierarchy (superuser pool): user, custom role + assignment, api client, approval, device. */
export async function createIdentityFixture(
  admin: Pool,
  h: HierarchyFixture,
): Promise<IdentityFixture> {
  const ids = {
    userId: randomUUID(),
    roleId: randomUUID(),
    assignmentId: randomUUID(),
    apiClientId: randomUUID(),
    approvalId: randomUUID(),
    deviceId: randomUUID(),
  };
  await admin.query(
    "INSERT INTO identity.users (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, 'Fixture User', 'active')",
    [ids.userId, h.tenantId, `${ids.userId.slice(0, 8)}@${h.slug}.test`],
  );
  await admin.query(
    "INSERT INTO identity.roles (id, tenant_id, key, name, is_system) VALUES ($1, $2, 'fixture_role', 'Fixture role', false)",
    [ids.roleId, h.tenantId],
  );
  await admin.query(
    "INSERT INTO identity.role_assignments (id, tenant_id, user_id, role_id, scope_kind, scope_id) VALUES ($1, $2, $3, $4, 'location', $5)",
    [ids.assignmentId, h.tenantId, ids.userId, ids.roleId, h.locationId],
  );
  await admin.query(
    "INSERT INTO identity.api_clients (id, tenant_id, name, client_id, secret_hash, scopes) VALUES ($1, $2, 'Fixture client', $3, 'x', '{tenancy.location.view}')",
    [ids.apiClientId, h.tenantId, `c_${ids.apiClientId.slice(0, 8)}`],
  );
  await admin.query(
    `INSERT INTO identity.approval_requests (id, tenant_id, location_id, kind, subject_kind, payload, payload_hash, requested_by)
     VALUES ($1, $2, $3, 'discount_over_limit', 'order_line', '{"permission":"orders.discount.apply","attributes":{"orders.discount.max_percent":25}}', 'hash', $4)`,
    [ids.approvalId, h.tenantId, h.locationId, ids.userId],
  );
  await admin.query(
    "INSERT INTO devices.devices (id, tenant_id, location_id, register_id, kind, name, enrollment_status, enrolled_at) VALUES ($1, $2, $3, $4, 'pos', 'Fixture device', 'enrolled', now())",
    [ids.deviceId, h.tenantId, h.locationId, h.registerId],
  );
  return ids;
}
