#!/usr/bin/env node
/**
 * `pnpm --filter @pos/db grants` — create the application role (local only) and apply the grant
 * matrix to DATABASE_URL. Run after `pnpm db:migrate`. APP_DB_ROLE / APP_DB_PASSWORD default to app_rw.
 */
import { createPool, databaseUrlFromEnv } from '../pool.js';
import { ensureAppRole, grantAppRole } from '../roles.js';

const role = process.env.APP_DB_ROLE ?? 'app_rw';
const password = process.env.APP_DB_PASSWORD ?? 'app_rw';
const pool = createPool({
  connectionString: databaseUrlFromEnv(),
  max: 1,
  applicationName: 'pos-grants',
});

try {
  const client = await pool.connect();
  try {
    await ensureAppRole(client, role, password);
    await grantAppRole(client, role);
    console.log(`[grants] role ${role} ready`);
  } finally {
    client.release();
  }
} catch (error) {
  console.error('[grants] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
