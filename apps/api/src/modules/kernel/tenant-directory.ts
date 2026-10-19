import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from '@pos/db';

import { PG_POOL } from './database.module.js';

export interface TenantRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: 'provisioning' | 'active' | 'suspended' | 'closed';
  readonly defaultCurrency: string;
  readonly defaultLocale: string;
  readonly defaultTimezone: string;
}

/**
 * platform.tenants has no RLS (operator-only schema, SELECT for the app role), so a tenant can be
 * looked up by slug before any tenant context exists — login, client credentials, device enrolment.
 */
@Injectable()
export class TenantDirectory {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findBySlug(slug: string): Promise<TenantRecord | null> {
    const result = await this.pool.query<Row>(`${SELECT} WHERE slug = $1`, [slug]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async findById(id: string): Promise<TenantRecord | null> {
    const result = await this.pool.query<Row>(`${SELECT} WHERE id = $1`, [id]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }
}

interface Row {
  id: string;
  slug: string;
  name: string;
  status: TenantRecord['status'];
  default_currency: string;
  default_locale: string;
  default_timezone: string;
}

const SELECT =
  'SELECT id, slug, name, status, default_currency, default_locale, default_timezone FROM platform.tenants';

function toRecord(row: Row): TenantRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    defaultCurrency: row.default_currency.trim(),
    defaultLocale: row.default_locale,
    defaultTimezone: row.default_timezone,
  };
}
