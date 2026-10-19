import type { SQL } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PoolClient, QueryResultRow } from 'pg';

/** @internal Key of the factory the unit of work uses; not re-exported from the package index. */
export const INTERNAL_CREATE: unique symbol = Symbol('TenantScopedDb.create');
/** @internal Called by the unit of work after COMMIT/ROLLBACK so an escaped handle cannot run on a recycled connection. */
export const INTERNAL_CLOSE: unique symbol = Symbol('TenantScopedDb.close');

/**
 * Database handle bound to one tenant (docs/01-system-architecture.md §6.2, isolation layer 2).
 *
 * It cannot be constructed by application code: only the unit of work creates it, after
 * `SET LOCAL app.tenant_id` succeeded and `platform.current_tenant()` was verified. Every query
 * issued through it therefore runs under the tenant's RLS policy, and the handle has no API to
 * change tenant. Repositories still write `tenant_id = ${db.tenantId}` predicates explicitly
 * (defence in depth; the RLS test suite proves a repository that forgets still cannot leak).
 */
export class TenantScopedDb {
  private closed = false;

  private constructor(
    public readonly tenantId: string,
    private readonly client: PoolClient,
    private readonly orm: NodePgDatabase,
  ) {}

  /** @internal Called by the unit of work only. */
  static [INTERNAL_CREATE](tenantId: string, client: PoolClient): TenantScopedDb {
    return new TenantScopedDb(tenantId, client, drizzle(client));
  }

  [INTERNAL_CLOSE](): void {
    this.closed = true;
  }

  /** Execute a Drizzle `sql` template (table identifiers from `schema/*`). */
  async execute<T extends QueryResultRow = QueryResultRow>(query: SQL): Promise<T[]> {
    this.assertOpen();
    const result = await this.orm.execute(query);
    return result.rows as T[];
  }

  /** Execute parameterised SQL text. */
  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    this.assertOpen();
    const result = await this.client.query<T>(text, params);
    return result.rows;
  }

  async one<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<T> {
    const rows = await this.query<T>(text, params);
    if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
    return rows[0]!;
  }

  async maybeOne<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    if (rows.length > 1) throw new Error(`Expected at most one row, got ${rows.length}`);
    return rows[0] ?? null;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('TenantScopedDb was used after its transaction ended');
  }
}
