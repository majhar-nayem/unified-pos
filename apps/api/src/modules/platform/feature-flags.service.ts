import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from '@pos/db';

import { PG_POOL } from '../kernel/public/index.js';

export interface FlagContext {
  readonly tenantId: string;
  readonly orgUnitIds?: readonly string[];
  readonly locationId?: string;
}

interface FlagRow {
  scope_kind: 'platform' | 'tenant' | 'org_unit' | 'location';
  scope_id: string | null;
  enabled: boolean;
}

const RANK: Record<FlagRow['scope_kind'], number> = {
  location: 3,
  org_unit: 2,
  tenant: 1,
  platform: 0,
};

/** Nearest scope wins: location > org unit > tenant > platform default. Pure. */
export function pickFlag(rows: readonly FlagRow[], ctx: FlagContext): boolean {
  let best: FlagRow | undefined;
  for (const row of rows) {
    const applies =
      row.scope_kind === 'platform' ||
      (row.scope_kind === 'tenant' && (row.scope_id === null || row.scope_id === ctx.tenantId)) ||
      (row.scope_kind === 'org_unit' &&
        row.scope_id !== null &&
        (ctx.orgUnitIds ?? []).includes(row.scope_id)) ||
      (row.scope_kind === 'location' && row.scope_id === ctx.locationId);
    if (applies && (!best || RANK[row.scope_kind] > RANK[best.scope_kind])) best = row;
  }
  return best?.enabled ?? false;
}

/** platform.feature_flags has no RLS: the tenant predicate is explicit. 30 s in-memory cache per key+tenant. */
@Injectable()
export class FeatureFlagsService {
  private readonly cache = new Map<string, { at: number; rows: FlagRow[] }>();

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async isEnabled(key: string, ctx: FlagContext): Promise<boolean> {
    const cacheKey = `${key}:${ctx.tenantId}`;
    const hit = this.cache.get(cacheKey);
    const rows =
      hit && Date.now() - hit.at < 30_000
        ? hit.rows
        : (
            await this.pool.query<FlagRow>(
              `SELECT scope_kind, scope_id, enabled FROM platform.feature_flags
               WHERE key = $1 AND (tenant_id = $2 OR (tenant_id IS NULL AND scope_kind = 'platform'))`,
              [key, ctx.tenantId],
            )
          ).rows;
    this.cache.set(cacheKey, { at: Date.now(), rows });
    return pickFlag(rows, ctx);
  }
}
