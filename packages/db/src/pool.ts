import pg from 'pg';

export type { Pool, PoolClient } from 'pg';

/**
 * bigint columns (money in minor units) come back as strings by default in node-postgres; parse them
 * to native bigint so no caller ever touches a float. int8 is OID 20.
 */
pg.types.setTypeParser(20, (value: string) => BigInt(value));

export interface PoolOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly applicationName?: string;
}

export function createPool(options: PoolOptions): pg.Pool {
  return new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'pos-platform',
  });
}

export function databaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATABASE_URL ?? 'postgres://pos:pos@localhost:5432/pos';
}
