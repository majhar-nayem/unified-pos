import { Injectable } from '@nestjs/common';
import type { TenantDto } from '@pos/contracts';
import { newId, type TenantUnitOfWork } from '@pos/db';

import { ConflictError } from '../kernel/public/index.js';
import { type TenantRow, toTenantDto } from './rows.js';

export interface TenantSkeletonInput {
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
  readonly region?: string;
  readonly defaultCurrency?: string;
  readonly defaultLocale?: string;
  readonly defaultTimezone?: string;
}

/** Creates the tenant row (SECURITY DEFINER), its root org unit, and activates it. Runs inside the provisioning transaction. */
@Injectable()
export class TenantSkeletonService {
  async create(
    uow: TenantUnitOfWork,
    input: TenantSkeletonInput,
  ): Promise<{ tenant: TenantDto; rootOrgUnitId: string }> {
    const existing = await uow.db.query<{ id: string }>(
      'SELECT id FROM platform.tenants WHERE slug = $1',
      [input.slug],
    );
    if (existing.length > 0)
      throw new ConflictError('TENANT_SLUG_TAKEN', `Tenant slug "${input.slug}" is already in use`);
    await uow.db.query('SELECT platform.fn_provision_tenant($1, $2, $3, $4, $5, $6, $7)', [
      input.tenantId,
      input.slug,
      input.name,
      input.region ?? null,
      input.defaultCurrency ?? null,
      input.defaultLocale ?? null,
      input.defaultTimezone ?? null,
    ]);
    const rootOrgUnitId = newId();
    await uow.db.query(
      `INSERT INTO tenancy.org_units (id, tenant_id, parent_id, kind, code, name) VALUES ($1, $2, NULL, 'company', 'root', $3)`,
      [rootOrgUnitId, input.tenantId, input.name],
    );
    await uow.db.query('SELECT platform.fn_activate_tenant($1)', [input.tenantId]);
    const tenant = await uow.db.one<TenantRow>('SELECT * FROM platform.tenants WHERE id = $1', [
      input.tenantId,
    ]);
    return { tenant: toTenantDto(tenant), rootOrgUnitId };
  }
}
