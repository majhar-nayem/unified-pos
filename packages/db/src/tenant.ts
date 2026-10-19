import type { Pool, PoolClient } from 'pg';

import { assertUuid } from './ids.js';

/**
 * Run `fn` inside one transaction with the RLS tenant context set
 * (docs/01-system-architecture.md §5.1: BEGIN; SET LOCAL app.tenant_id; ... COMMIT).
 *
 * `SET LOCAL` scopes the setting to the transaction, so a pooled connection never leaks a tenant.
 * The tenant id must come from the verified principal, never from a request path or body.
 *
 * Prefer `runInTenantTransaction` (unit-of-work.ts) in application code: it adds the outbox and
 * audit flush. This low-level helper stays for tests and migrations-adjacent tooling.
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertUuid(tenantId, 'tenantId');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

/** Transaction without a tenant context (platform operators, relay). RLS yields zero rows. */
export async function withoutTenant<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}
