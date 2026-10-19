#!/usr/bin/env node
/**
 * `pnpm --filter @pos/db schema:check` — compare the Drizzle mirrors (src/schema/*.ts) with the
 * migrated database at DATABASE_URL (default: the docker-compose instance). Exit 1 on drift.
 * CI runs the same check against a Testcontainers database in
 * packages/testing/src/schema-mirror.integration.test.ts.
 */
import { createPool, databaseUrlFromEnv } from '../pool.js';
import { checkSchemaMirror, formatSchemaDrift, mirroredTables } from '../schema-check.js';

const pool = createPool({
  connectionString: databaseUrlFromEnv(),
  max: 1,
  applicationName: 'pos-schema-check',
});

try {
  const drift = await checkSchemaMirror(pool);
  const tables = mirroredTables().length;
  if (drift.length === 0) {
    console.log(`[schema:check] ${tables} mirrored tables match the database`);
  } else {
    console.error(`[schema:check] ${drift.length} difference(s) across ${tables} mirrored tables:`);
    console.error(formatSchemaDrift(drift));
    process.exitCode = 1;
  }
} catch (error) {
  console.error('[schema:check] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
