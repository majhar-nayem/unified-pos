import type { Pool, PoolClient } from 'pg';

import { appendAudit } from './audit/append.js';
import type { AuditActor, AuditEntryInput } from './audit/types.js';
import { assertUuid } from './ids.js';
import { appendOutbox, type OutboxEventInput } from './outbox.js';
import { INTERNAL_CLOSE, INTERNAL_CREATE, TenantScopedDb } from './tenant-scoped-db.js';

export interface UnitOfWorkOptions {
  readonly actor?: AuditActor;
  readonly correlationId?: string | null;
  readonly causationId?: string | null;
}

/**
 * What an application service sees inside `runInTenantTransaction`
 * (docs/01-system-architecture.md §5.1): the tenant-bound db, plus buffers for domain events
 * (outbox) and audit entries, both flushed in the same transaction right before COMMIT.
 */
export interface TenantUnitOfWork {
  readonly db: TenantScopedDb;
  readonly tenantId: string;
  emit(event: OutboxEventInput): void;
  audit(entry: AuditEntryInput): void;
  /** Runs after a successful COMMIT (cache invalidation, notifications). Never inside the transaction. */
  onCommitted(callback: () => void | Promise<void>): void;
}

const SYSTEM_ACTOR: AuditActor = { kind: 'system' };

/**
 * BEGIN → SET LOCAL app.tenant_id → fn → outbox.append → audit.record → COMMIT.
 * The tenant id must come from the verified principal. Every write that mutates financial or
 * inventory state runs inside exactly one of these.
 */
export async function runInTenantTransaction<T>(
  pool: Pool,
  tenantId: string,
  fn: (uow: TenantUnitOfWork) => Promise<T>,
  options: UnitOfWorkOptions = {},
): Promise<T> {
  assertUuid(tenantId, 'tenantId');
  const client = await pool.connect();
  const events: OutboxEventInput[] = [];
  const entries: AuditEntryInput[] = [];
  const committed: Array<() => void | Promise<void>> = [];
  let db: TenantScopedDb | undefined;
  try {
    await client.query('BEGIN');
    try {
      db = await enterTenant(client, tenantId);
      const uow: TenantUnitOfWork = {
        db,
        tenantId,
        emit: (event) => void events.push(event),
        audit: (entry) => void entries.push(entry),
        onCommitted: (cb) => void committed.push(cb),
      };
      const result = await fn(uow);
      const headers = {
        ...(options.correlationId ? { correlation_id: options.correlationId } : {}),
        ...(options.causationId ? { causation_id: options.causationId } : {}),
        actor: options.actor ?? SYSTEM_ACTOR,
      };
      await appendOutbox(db, events, headers);
      await appendAudit(db, entries, {
        actor: options.actor ?? SYSTEM_ACTOR,
        correlationId: options.correlationId ?? null,
      });
      await client.query('COMMIT');
      db[INTERNAL_CLOSE]();
      for (const cb of committed) await cb();
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    db?.[INTERNAL_CLOSE]();
    client.release();
  }
}

/** Read-only transaction with the tenant context set (queries, scope resolution). */
export async function readInTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (db: TenantScopedDb) => Promise<T>,
): Promise<T> {
  assertUuid(tenantId, 'tenantId');
  const client = await pool.connect();
  let db: TenantScopedDb | undefined;
  try {
    await client.query('BEGIN READ ONLY');
    try {
      db = await enterTenant(client, tenantId);
      const result = await fn(db);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    db?.[INTERNAL_CLOSE]();
    client.release();
  }
}

async function enterTenant(client: PoolClient, tenantId: string): Promise<TenantScopedDb> {
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  const check = await client.query<{ tenant: string | null }>(
    'SELECT platform.current_tenant()::text AS tenant',
  );
  if (check.rows[0]?.tenant !== tenantId) {
    throw new Error('RLS tenant context was not established; refusing to run tenant work');
  }
  return TenantScopedDb[INTERNAL_CREATE](tenantId, client);
}
