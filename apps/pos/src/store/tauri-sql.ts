import { type SqlDatabase, type SqlValue } from './sql.js';
import { migrate, recordEncryptionMode } from './schema.js';
import { createSqliteStore, type LocalStore } from './stores.js';

/** `SqlDatabase` over `@tauri-apps/plugin-sql` (SQLite file in the app data dir). */
export async function openTauriSql(path = 'sqlite:pos.db'): Promise<SqlDatabase> {
  const { default: Database } = await import('@tauri-apps/plugin-sql');
  const db = await Database.load(path);
  const adapter: SqlDatabase = {
    async execute(sql: string, params: readonly SqlValue[] = []) {
      const result = await db.execute(sql, [...params]);
      return { rowsAffected: result.rowsAffected };
    },
    async select<T extends Record<string, unknown>>(sql: string, params: readonly SqlValue[] = []) {
      return db.select<T[]>(sql, [...params]);
    },
  };
  await adapter.execute('PRAGMA journal_mode = WAL');
  await adapter.execute('PRAGMA foreign_keys = ON');
  return adapter;
}

export async function openTauriStore(): Promise<LocalStore> {
  const db = await openTauriSql();
  await migrate(db);
  await recordEncryptionMode(db, 'simulated');
  return createSqliteStore(db, 'simulated');
}
