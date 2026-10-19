import type { PoolClient } from 'pg';

import { newId } from './ids.js';
import type { TenantScopedDb } from './tenant-scoped-db.js';

/** A domain event buffered by a unit of work and written to audit.outbox_events at commit. */
export interface OutboxEventInput {
  readonly type: string; // from contracts EVENT_CATALOG
  readonly aggregateKind: string;
  readonly aggregateId: string;
  readonly aggregateVersion?: number | null;
  readonly locationId?: string | null;
  readonly payload: Record<string, unknown>;
  readonly headers?: Record<string, unknown>;
}

export interface OutboxEventRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly location_id: string | null;
  readonly aggregate_kind: string;
  readonly aggregate_id: string;
  readonly aggregate_version: number | null;
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
  readonly headers: Record<string, unknown>;
  readonly occurred_at: Date;
  readonly published_at: Date | null;
  readonly attempts: number;
  readonly last_error: string | null;
}

export async function appendOutbox(
  db: TenantScopedDb,
  events: readonly OutboxEventInput[],
  headers: Record<string, unknown> = {},
): Promise<string[]> {
  const ids: string[] = [];
  for (const event of events) {
    const id = newId();
    await db.query(
      `INSERT INTO audit.outbox_events
         (id, tenant_id, location_id, aggregate_kind, aggregate_id, aggregate_version, event_type, payload, headers)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        db.tenantId,
        event.locationId ?? null,
        event.aggregateKind,
        event.aggregateId,
        event.aggregateVersion ?? null,
        event.type,
        JSON.stringify(event.payload),
        JSON.stringify({ ...headers, ...(event.headers ?? {}) }),
      ],
    );
    ids.push(id);
  }
  return ids;
}

// --- relay side (runs without a tenant context; the SECURITY DEFINER functions from migration 0002 cross tenants) ---

export async function claimOutboxBatch(
  client: PoolClient,
  limit: number,
  maxAttempts = 10,
): Promise<OutboxEventRow[]> {
  const result = await client.query<OutboxEventRow>(
    'SELECT * FROM audit.fn_claim_outbox_batch($1, $2)',
    [limit, maxAttempts],
  );
  return result.rows;
}

export async function markOutboxPublished(
  client: PoolClient,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await client.query('SELECT audit.fn_mark_outbox_published($1::uuid[])', [ids]);
}

export async function markOutboxFailed(
  client: PoolClient,
  id: string,
  error: string,
): Promise<void> {
  await client.query('SELECT audit.fn_mark_outbox_failed($1, $2)', [id, error.slice(0, 2000)]);
}

/** Final failure: never reclaimed, keeps the error. */
export async function markOutboxDead(client: PoolClient, id: string, error: string): Promise<void> {
  await client.query('SELECT audit.fn_mark_outbox_dead($1, $2)', [id, error.slice(0, 2000)]);
}

/** Returns true when the consumer sees this event for the first time (dedupe for at-least-once delivery). */
export async function recordProcessedEvent(
  client: PoolClient,
  consumer: string,
  eventId: string,
): Promise<boolean> {
  const result = await client.query(
    'INSERT INTO audit.processed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id',
    [consumer, eventId],
  );
  return result.rowCount === 1;
}
