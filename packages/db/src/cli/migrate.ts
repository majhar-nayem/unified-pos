#!/usr/bin/env node
/**
 * `pnpm db:migrate` — apply pending migrations to DATABASE_URL
 * (default postgres://pos:pos@localhost:5432/pos, matching infra/docker/docker-compose.yml).
 */
import { migrate } from '../migrate.js';
import { createPool, databaseUrlFromEnv } from '../pool.js';

const url = databaseUrlFromEnv();
const pool = createPool({ connectionString: url, max: 1, applicationName: 'pos-migrate' });

try {
  const result = await migrate(pool, { log: (m) => console.log(`[migrate] ${m}`) });
  console.log(
    `[migrate] done: applied ${result.applied.length ? result.applied.join(', ') : 'nothing'}` +
      (result.skipped.length ? `; already applied ${result.skipped.join(', ')}` : ''),
  );
} catch (error) {
  console.error('[migrate] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
