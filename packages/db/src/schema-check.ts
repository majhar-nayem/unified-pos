import { is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';

import * as mirrors from './schema/index.js';

/**
 * Drizzle mirror ↔ live schema diff (Sprint 0 exit criterion). The SQL in db/*.sql and
 * packages/db/migrations is canonical; the mirrors in src/schema/*.ts must match it column for
 * column. `checkSchemaMirror` introspects information_schema and reports every difference.
 */

export interface MirroredColumn {
  readonly name: string;
  /** Canonical SQL type, see `canonicalType`. */
  readonly type: string;
  readonly notNull: boolean;
  readonly hasDefault: boolean;
}

export interface MirroredTable {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly MirroredColumn[];
}

export interface LiveColumn extends MirroredColumn {
  readonly position: number;
}

export type LiveSchema = ReadonlyMap<string, ReadonlyMap<string, LiveColumn>>;

export type SchemaDriftKind =
  | 'missing_table'
  | 'missing_column'
  | 'unmirrored_column'
  | 'type_mismatch'
  | 'nullability_mismatch'
  | 'default_mismatch';

export interface SchemaDrift {
  readonly kind: SchemaDriftKind;
  /** `schema.table` */
  readonly table: string;
  readonly column?: string;
  readonly expected?: string;
  readonly actual?: string;
}

/** `numeric(14, 4)` → `numeric(14,4)`, lower case, single spaces. */
export function canonicalType(type: string): string {
  return type.toLowerCase().replace(/\s+/g, ' ').replace(/,\s+/g, ',').trim();
}

/** Every Drizzle table exported from src/schema (or a given module), as plain data. */
export function mirroredTables(source: Record<string, unknown> = mirrors): MirroredTable[] {
  const tables: MirroredTable[] = [];
  for (const value of Object.values(source)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    tables.push({
      schema: config.schema ?? 'public',
      name: config.name,
      columns: config.columns.map((column) => ({
        name: column.name,
        type: canonicalType(column.getSQLType()),
        notNull: column.notNull,
        hasDefault: column.hasDefault,
      })),
    });
  }
  return tables.sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`));
}

interface InformationSchemaColumn {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  datetime_precision: number | null;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  ordinal_position: number;
}

/** information_schema.columns → the type spelling Drizzle's `getSQLType()` produces. */
export function liveColumnType(column: InformationSchemaColumn): string {
  const { data_type: dataType, udt_name: udt } = column;
  switch (dataType) {
    case 'ARRAY':
      return `${udt.replace(/^_/, '')}[]`;
    case 'USER-DEFINED':
      return udt;
    case 'character':
      return column.character_maximum_length === null
        ? 'char'
        : `char(${column.character_maximum_length})`;
    case 'character varying':
      return column.character_maximum_length === null
        ? 'varchar'
        : `varchar(${column.character_maximum_length})`;
    case 'numeric':
      return column.numeric_precision === null
        ? 'numeric'
        : `numeric(${column.numeric_precision},${column.numeric_scale ?? 0})`;
    case 'timestamp without time zone':
      return 'timestamp';
    case 'time without time zone':
      return 'time';
    default:
      return dataType;
  }
}

/** Columns of every table in `schemas`, keyed `schema.table` → column name. */
export async function introspectLiveSchema(
  pool: Pool,
  schemas: readonly string[],
): Promise<LiveSchema> {
  const result = await pool.query<InformationSchemaColumn>(
    `SELECT table_schema, table_name, column_name, data_type, udt_name, character_maximum_length,
            numeric_precision, numeric_scale, datetime_precision, is_nullable, column_default, ordinal_position
       FROM information_schema.columns
      WHERE table_schema = ANY($1::text[])
      ORDER BY table_schema, table_name, ordinal_position`,
    [schemas],
  );
  const live = new Map<string, Map<string, LiveColumn>>();
  for (const row of result.rows) {
    const key = `${row.table_schema}.${row.table_name}`;
    let columns = live.get(key);
    if (!columns) {
      columns = new Map();
      live.set(key, columns);
    }
    columns.set(row.column_name, {
      name: row.column_name,
      type: canonicalType(liveColumnType(row)),
      notNull: row.is_nullable === 'NO',
      hasDefault: row.column_default !== null,
      position: Number(row.ordinal_position),
    });
  }
  return live;
}

/** Pure comparison; the mirror is the expectation, the live schema the actual. */
export function diffSchema(mirror: readonly MirroredTable[], live: LiveSchema): SchemaDrift[] {
  const drift: SchemaDrift[] = [];
  for (const table of mirror) {
    const key = `${table.schema}.${table.name}`;
    const liveColumns = live.get(key);
    if (!liveColumns) {
      drift.push({ kind: 'missing_table', table: key });
      continue;
    }
    for (const column of table.columns) {
      const actual = liveColumns.get(column.name);
      if (!actual) {
        drift.push({ kind: 'missing_column', table: key, column: column.name });
        continue;
      }
      if (actual.type !== column.type)
        drift.push({
          kind: 'type_mismatch',
          table: key,
          column: column.name,
          expected: column.type,
          actual: actual.type,
        });
      if (actual.notNull !== column.notNull)
        drift.push({
          kind: 'nullability_mismatch',
          table: key,
          column: column.name,
          expected: column.notNull ? 'NOT NULL' : 'NULL',
          actual: actual.notNull ? 'NOT NULL' : 'NULL',
        });
      if (actual.hasDefault !== column.hasDefault)
        drift.push({
          kind: 'default_mismatch',
          table: key,
          column: column.name,
          expected: column.hasDefault ? 'has default' : 'no default',
          actual: actual.hasDefault ? 'has default' : 'no default',
        });
    }
    const mirrored = new Set(table.columns.map((c) => c.name));
    for (const column of [...liveColumns.values()].sort((a, b) => a.position - b.position))
      if (!mirrored.has(column.name))
        drift.push({
          kind: 'unmirrored_column',
          table: key,
          column: column.name,
          actual: `${column.type}${column.notNull ? ' not null' : ''}`,
        });
  }
  return drift;
}

export function formatSchemaDrift(drift: readonly SchemaDrift[]): string {
  return drift
    .map((d) => {
      const where = d.column ? `${d.table}.${d.column}` : d.table;
      switch (d.kind) {
        case 'missing_table':
          return `${where}: table is in the Drizzle mirror but not in the database`;
        case 'missing_column':
          return `${where}: column is in the Drizzle mirror but not in the database`;
        case 'unmirrored_column':
          return `${where}: column exists in the database (${d.actual}) but not in the Drizzle mirror`;
        case 'type_mismatch':
          return `${where}: type is ${d.actual} in the database, ${d.expected} in the mirror`;
        case 'nullability_mismatch':
          return `${where}: ${d.actual} in the database, ${d.expected} in the mirror`;
        case 'default_mismatch':
          return `${where}: ${d.actual} in the database, ${d.expected} in the mirror`;
      }
    })
    .join('\n');
}

/** Compare every table in src/schema against the database behind `pool`. Empty array = no drift. */
export async function checkSchemaMirror(
  pool: Pool,
  source: Record<string, unknown> = mirrors,
): Promise<SchemaDrift[]> {
  const mirror = mirroredTables(source);
  const schemas = [...new Set(mirror.map((t) => t.schema))];
  const live = await introspectLiveSchema(pool, schemas);
  return diffSchema(mirror, live);
}
