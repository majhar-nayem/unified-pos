/** Minimal SQL port. Tauri's SQL plugin implements it in the app; node:sqlite implements it in tests. */
export interface SqlDatabase {
  execute(sql: string, params?: readonly SqlValue[]): Promise<{ rowsAffected: number }>;
  select<T extends Record<string, unknown>>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<T[]>;
}

export type SqlValue = string | number | null;

/** `$1, $2, ...$n` starting at `from` (the Tauri SQL plugin binds `$n`; SQLite accepts it everywhere). */
export function placeholders(count: number, from = 1): string {
  return Array.from({ length: count }, (_, i) => `$${from + i}`).join(', ');
}
