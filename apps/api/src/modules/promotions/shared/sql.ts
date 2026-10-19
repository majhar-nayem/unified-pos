import type { Page } from '@pos/contracts';
import type { TenantScopedDb } from '@pos/db';

// pg's QueryResultRow, without making apps/api depend on pg directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QueryResultRow = { [column: string]: any };

/** Column map entry: the SQL column and whether the value is serialised as JSON (jsonb columns). */
export interface ColumnSpec {
  readonly column: string;
  readonly json?: boolean;
}
export type ColumnMap = Readonly<Record<string, string | ColumnSpec>>;

/** Build `SET a = $n, b = $m` from a camelCase patch using an explicit column map (undefined = untouched). */
export function buildPatch(
  patch: Record<string, unknown>,
  columns: ColumnMap,
  startIndex = 1,
): { set: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [field, spec] of Object.entries(columns)) {
    if (!(field in patch) || patch[field] === undefined) continue;
    const { column, json } = typeof spec === 'string' ? { column: spec, json: false } : spec;
    params.push(json ? JSON.stringify(patch[field]) : patch[field]);
    parts.push(`${column} = $${startIndex + params.length - 1}`);
  }
  return { set: parts.join(', '), params };
}

export interface PageQuery {
  /** `FROM … [JOIN …]` and the table alias whose `id` paginates. */
  readonly from: string;
  readonly alias?: string;
  /** Extra predicates after `tenant_id = $1`; use `?` for the next parameter. */
  readonly where?: readonly { readonly sql: string; readonly value: unknown }[];
  readonly select?: string;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

/**
 * Cursor pagination over UUIDv7 ids: `id > cursor ORDER BY id LIMIT n + 1`; the extra row says
 * whether there is a next page and `nextCursor` is the last id of the page.
 */
export async function queryPage<Row extends QueryResultRow & { id: string }, Dto>(
  db: TenantScopedDb,
  query: PageQuery,
  map: (row: Row) => Dto,
): Promise<Page<Dto>> {
  const alias = query.alias ?? 't';
  const params: unknown[] = [db.tenantId];
  const clauses = [`${alias}.tenant_id = $1`];
  for (const { sql, value } of query.where ?? []) {
    params.push(value);
    clauses.push(sql.replace('?', `$${params.length}`));
  }
  if (query.cursor) {
    params.push(query.cursor);
    clauses.push(`${alias}.id > $${params.length}`);
  }
  const rows = await db.query<Row>(
    `SELECT ${query.select ?? `${alias}.*`} FROM ${query.from} WHERE ${clauses.join(' AND ')}
     ORDER BY ${alias}.id LIMIT ${query.limit + 1}`,
    params,
  );
  const page = rows.slice(0, query.limit);
  return {
    items: page.map(map),
    nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}
