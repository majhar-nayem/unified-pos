/** `SqlDatabase` over node:sqlite for tests. Loaded through createRequire: Vite strips the `node:` prefix of prefix-only builtins. */
import { createRequire } from 'node:module';

import type { SqlDatabase, SqlValue } from '../store/sql.js';

interface NodeStatement {
  run(...params: SqlValue[]): { changes: number | bigint };
  all(...params: SqlValue[]): Record<string, unknown>[];
}
interface NodeDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeStatement;
  close(): void;
}

/** node:sqlite binds `?NNN` positionally; the app's `$NNN` (Tauri SQL plugin style) is rewritten to it. */
const toNumbered = (sql: string) => sql.replace(/\$(\d+)/g, '?$1');

export function openNodeSqlite(path = ':memory:'): SqlDatabase & { close(): void } {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
    DatabaseSync: new (path: string) => NodeDatabase;
  };
  const db = new DatabaseSync(path);
  let open = true;
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  return {
    async execute(sql, params = []) {
      const result = db.prepare(toNumbered(sql)).run(...params);
      return { rowsAffected: Number(result.changes) };
    },
    async select<T extends Record<string, unknown>>(sql: string, params: readonly SqlValue[] = []) {
      return db.prepare(toNumbered(sql)).all(...params) as T[];
    },
    close: () => {
      if (open) db.close();
      open = false;
    },
  };
}
