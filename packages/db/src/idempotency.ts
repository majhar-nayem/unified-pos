import type { PoolClient } from 'pg';

import type { TenantScopedDb } from './tenant-scoped-db.js';

export interface IdempotencyKeyRef {
  /** principal or api client id + route (docs/02 §3.13). */
  readonly scope: string;
  readonly key: string;
}

export type IdempotencyReservation =
  | { readonly outcome: 'reserved' }
  | { readonly outcome: 'replay'; readonly status: number; readonly body: unknown }
  | { readonly outcome: 'in_flight' }
  | { readonly outcome: 'mismatch' };

/**
 * Reserve a key for this request. Same key + same request hash after completion → replay;
 * different hash → mismatch; same key while the first request is still running → in_flight.
 * Expired rows are reclaimed transparently.
 */
export async function reserveIdempotencyKey(
  db: TenantScopedDb,
  ref: IdempotencyKeyRef,
  requestHash: string,
): Promise<IdempotencyReservation> {
  const inserted = await db.query<{ key: string }>(
    `INSERT INTO audit.idempotency_keys (tenant_id, scope, key, request_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, scope, key) DO NOTHING
     RETURNING key`,
    [db.tenantId, ref.scope, ref.key, requestHash],
  );
  if (inserted.length === 1) return { outcome: 'reserved' };

  const existing = await db.one<{
    request_hash: string;
    response_status: number | null;
    response_body: unknown;
    expired: boolean;
  }>(
    `SELECT request_hash, response_status, response_body, expires_at < now() AS expired
     FROM audit.idempotency_keys
     WHERE tenant_id = $1 AND scope = $2 AND key = $3
     FOR UPDATE`,
    [db.tenantId, ref.scope, ref.key],
  );
  if (existing.expired) {
    await db.query(
      `UPDATE audit.idempotency_keys
       SET request_hash = $4, response_status = NULL, response_body = NULL,
           created_at = now(), expires_at = now() + interval '24 hours'
       WHERE tenant_id = $1 AND scope = $2 AND key = $3`,
      [db.tenantId, ref.scope, ref.key, requestHash],
    );
    return { outcome: 'reserved' };
  }
  if (existing.request_hash !== requestHash) return { outcome: 'mismatch' };
  if (existing.response_status === null) return { outcome: 'in_flight' };
  return { outcome: 'replay', status: existing.response_status, body: existing.response_body };
}

export async function completeIdempotencyKey(
  db: TenantScopedDb,
  ref: IdempotencyKeyRef,
  response: { status: number; body: unknown },
): Promise<void> {
  await db.query(
    `UPDATE audit.idempotency_keys SET response_status = $4, response_body = $5
     WHERE tenant_id = $1 AND scope = $2 AND key = $3`,
    [
      db.tenantId,
      ref.scope,
      ref.key,
      response.status,
      response.body === undefined ? null : JSON.stringify(response.body),
    ],
  );
}

/** Drop an unfinished reservation so the client can retry after a failure. */
export async function releaseIdempotencyKey(
  db: TenantScopedDb,
  ref: IdempotencyKeyRef,
): Promise<void> {
  await db.query(
    `DELETE FROM audit.idempotency_keys
     WHERE tenant_id = $1 AND scope = $2 AND key = $3 AND response_status IS NULL`,
    [db.tenantId, ref.scope, ref.key],
  );
}

/** Worker job; crosses tenants through the SECURITY DEFINER function from migration 0002. */
export async function purgeExpiredIdempotencyKeys(client: PoolClient): Promise<number> {
  const result = await client.query<{ purged: number }>(
    'SELECT audit.fn_purge_idempotency_keys() AS purged',
  );
  return Number(result.rows[0]?.purged ?? 0);
}
