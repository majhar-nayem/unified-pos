/**
 * Local SQLite schema: the three table groups of docs/01-system-architecture.md §8.1.
 *
 *   1. Replicas (read-only on device)    replica_records, replica_barcodes, replica_cursors, replica_staff
 *   2. Command log (append-only)         commands
 *   3. Local projections                 local_projections
 *
 * Plus `store_meta` (schema version, encryption mode). Migrations are append-only statements keyed
 * by version; `migrate()` applies the missing ones in order.
 */
import type { SqlDatabase } from './sql.js';

export const MIGRATIONS: ReadonlyArray<{
  readonly version: number;
  readonly statements: readonly string[];
}> = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS store_meta (
         key   TEXT PRIMARY KEY,
         value TEXT NOT NULL
       )`,

      // --- group 1: replicas -------------------------------------------------------------------
      // Generic change-feed target: one row per (stream, entity, id), newest version wins.
      `CREATE TABLE IF NOT EXISTS replica_records (
         stream    TEXT    NOT NULL,
         entity    TEXT    NOT NULL,
         entity_id TEXT    NOT NULL,
         version   INTEGER NOT NULL,
         seq       INTEGER NOT NULL,
         payload   TEXT    NOT NULL,
         PRIMARY KEY (stream, entity, entity_id)
       )`,
      `CREATE INDEX IF NOT EXISTS replica_records_by_entity ON replica_records (stream, entity)`,
      // Scan lookup (< 100 ms budget): barcode → variant, maintained by the feed applier.
      `CREATE TABLE IF NOT EXISTS replica_barcodes (
         code       TEXT PRIMARY KEY,
         variant_id TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS replica_barcodes_by_variant ON replica_barcodes (variant_id)`,
      `CREATE TABLE IF NOT EXISTS replica_cursors (
         stream TEXT PRIMARY KEY,
         cursor INTEGER NOT NULL
       )`,
      // Staff shown on the PIN screen. PIN hashes are never replicated in this slice (verification is server-side).
      `CREATE TABLE IF NOT EXISTS replica_staff (
         user_id      TEXT PRIMARY KEY,
         display_name TEXT NOT NULL,
         last_used_at TEXT
       )`,

      // --- group 2: command log ----------------------------------------------------------------
      `CREATE TABLE IF NOT EXISTS commands (
         client_command_id TEXT    PRIMARY KEY,
         seq               INTEGER NOT NULL UNIQUE,
         type              TEXT    NOT NULL,
         payload           TEXT    NOT NULL,
         hlc               TEXT    NOT NULL,
         created_at        TEXT    NOT NULL,
         status            TEXT    NOT NULL CHECK (status IN ('pending','in_flight','acked','rejected')),
         batch_id          TEXT,
         server_result     TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS commands_by_status ON commands (status, seq)`,

      // --- group 3: local projections ----------------------------------------------------------
      // The device's own orders/checks/intents, rebuilt by applying its commands with domain-core reducers.
      `CREATE TABLE IF NOT EXISTS local_projections (
         kind        TEXT NOT NULL,
         id          TEXT NOT NULL,
         payload     TEXT NOT NULL,
         updated_hlc TEXT NOT NULL,
         PRIMARY KEY (kind, id)
       )`,
    ],
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export async function migrate(db: SqlDatabase): Promise<{ from: number; to: number }> {
  await db.execute(
    'CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  );
  const rows = await db.select<{ value: string }>(
    "SELECT value FROM store_meta WHERE key = 'schema_version'",
  );
  const from = rows[0] ? Number(rows[0].value) : 0;
  let current = from;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    for (const statement of migration.statements) await db.execute(statement);
    current = migration.version;
    await db.execute(
      `INSERT INTO store_meta (key, value) VALUES ('schema_version', $1)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [String(current)],
    );
  }
  return { from, to: current };
}

export type EncryptionMode = 'simulated' | 'sqlcipher';

/**
 * Encryption at rest (docs/01 §8.1: SQLCipher, key in the OS keychain).
 *
 * **Simulated:** the Tauri SQL plugin ships plain SQLite, so SQLCipher is not wired yet. The mode is
 * recorded in `store_meta` and surfaced on the diagnostics screen so nobody mistakes it for real
 * encryption. Wiring SQLCipher means building libsqlite3-sys with `bundled-sqlcipher` and issuing
 * `PRAGMA key` from the keychain before the first query.
 */
export async function recordEncryptionMode(db: SqlDatabase, mode: EncryptionMode): Promise<void> {
  await db.execute(
    `INSERT INTO store_meta (key, value) VALUES ('encryption', $1)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [mode],
  );
}

export async function readEncryptionMode(db: SqlDatabase): Promise<EncryptionMode | null> {
  const rows = await db.select<{ value: string }>(
    "SELECT value FROM store_meta WHERE key = 'encryption'",
  );
  return (rows[0]?.value as EncryptionMode | undefined) ?? null;
}
