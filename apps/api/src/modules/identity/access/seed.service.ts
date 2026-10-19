import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { PERMISSIONS, SYSTEM_ROLES } from '@pos/auth';
import type { Pool } from '@pos/db';
import { createLogger } from '@pos/observability';

import { PG_POOL } from '../../kernel/public/index.js';

/** Seeds identity.permissions and the system roles from @pos/auth's catalog (SECURITY DEFINER function). */
@Injectable()
export class SeedService implements OnApplicationBootstrap {
  private readonly logger = createLogger({ service: 'identity.seed' });

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.SKIP_ACCESS_SEED === '1') return;
    await seedAccessCatalog(this.pool);
    this.logger.info(
      { permissions: PERMISSIONS.length, roles: SYSTEM_ROLES.length },
      'access catalog seeded',
    );
  }
}

export async function seedAccessCatalog(pool: Pool): Promise<void> {
  const permissions = PERMISSIONS.map((p) => ({
    key: p.key,
    module: p.module,
    description: p.description,
    isSensitive: p.isSensitive,
  }));
  const roles = SYSTEM_ROLES.map((r) => ({
    key: r.key,
    name: r.name,
    description: r.description,
    permissions: r.permissions,
  }));
  await pool.query('SELECT identity.fn_seed_access_catalog($1::jsonb, $2::jsonb)', [
    JSON.stringify(permissions),
    JSON.stringify(roles),
  ]);
}
