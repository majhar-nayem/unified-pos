import { createHash } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { MIGRATIONS, type Migration, readMigrationSql, repoRoot } from './migrations.js';

export interface MigrateOptions {
  /** Override the repo root (tests). */
  readonly root?: string;
  readonly migrations?: readonly Migration[];
  readonly log?: (message: string) => void;
}

export interface MigrateResult {
  readonly applied: string[];
  readonly skipped: string[];
}

const MIGRATIONS_TABLE = 'public.schema_migrations';

/**
 * Apply pending migrations. Each migration runs in its own transaction with an advisory lock so
 * concurrent deploys cannot double-apply. A checksum guards against editing an applied migration.
 */
export async function migrate(pool: Pool, options: MigrateOptions = {}): Promise<MigrateResult> {
  const root = options.root ?? repoRoot();
  const migrations = options.migrations ?? MIGRATIONS;
  const log = options.log ?? (() => undefined);
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        id         text PRIMARY KEY,
        name       text NOT NULL,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    await assertMigratorPrivileges(client);
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      const existing = await client.query<{ id: string; checksum: string }>(
        `SELECT id, checksum FROM ${MIGRATIONS_TABLE}`,
      );
      const byId = new Map(existing.rows.map((r) => [r.id, r.checksum]));

      for (const migration of migrations) {
        const sql = readMigrationSql(migration, root);
        const checksum = sha256(sql);
        const previous = byId.get(migration.id);
        if (previous !== undefined) {
          if (previous !== checksum) {
            throw new Error(
              `Migration ${migration.id}_${migration.name} was already applied with a different checksum; ` +
                'migrations are immutable once applied (add a new expand-only migration instead).',
            );
          }
          skipped.push(migration.id);
          continue;
        }
        log(`applying ${migration.id}_${migration.name} (${migration.files.join(', ')})`);
        await applyInTransaction(client, migration, sql, checksum);
        applied.push(migration.id);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
  return { applied, skipped };
}

const MIGRATION_LOCK_KEY = 7_340_032; // arbitrary, stable

/**
 * Every tenant table FORCEs row level security, so the owner of SECURITY DEFINER functions
 * (= the migration role) must be able to bypass RLS or the relay, provisioning and seeding
 * functions from migration 0002 silently see zero rows.
 */
async function assertMigratorPrivileges(client: PoolClient): Promise<void> {
  const result = await client.query<{ ok: boolean; rolname: string }>(
    'SELECT rolname, (rolsuper OR rolbypassrls) AS ok FROM pg_roles WHERE rolname = current_user',
  );
  const row = result.rows[0];
  if (!row?.ok) {
    throw new Error(
      `Migration role "${row?.rolname ?? 'unknown'}" must be a superuser or have BYPASSRLS ` +
        '(SECURITY DEFINER functions are subject to FORCE ROW LEVEL SECURITY otherwise).',
    );
  }
}

async function applyInTransaction(
  client: PoolClient,
  migration: Migration,
  sql: string,
  checksum: string,
) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (id, name, checksum) VALUES ($1, $2, $3)`, [
      migration.id,
      migration.name,
      checksum,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
