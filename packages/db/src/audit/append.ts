import { newId } from '../ids.js';
import type { TenantScopedDb } from '../tenant-scoped-db.js';
import { auditHash, type AuditRowForHash } from './chain.js';
import type { AppendedAuditRow, AuditActor, AuditEntryInput } from './types.js';

export interface AppendAuditContext {
  readonly actor: AuditActor;
  readonly correlationId?: string | null;
}

/**
 * Append entries to the tenant's hash chain inside the current transaction.
 * Serialised per tenant with a transaction-scoped advisory lock (docs/02 §3.13); ids and
 * occurred_at are generated here so the hashed bytes are known before the insert.
 */
export async function appendAudit(
  db: TenantScopedDb,
  entries: readonly AuditEntryInput[],
  ctx: AppendAuditContext,
): Promise<AppendedAuditRow[]> {
  if (entries.length === 0) return [];
  const tenantId = db.tenantId;

  await db.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['audit', tenantId]);
  const head = await db.maybeOne<{ head_hash: Buffer; head_seq: bigint }>(
    'SELECT head_hash, head_seq FROM audit.audit_chain_heads WHERE tenant_id = $1 FOR UPDATE',
    [tenantId],
  );
  const seqRows = await db.query<{ seq: bigint }>(
    "SELECT nextval('audit.audit_log_seq') AS seq FROM generate_series(1, $1::int)",
    [entries.length],
  );

  let prevHash: Buffer | null = head?.head_hash ?? null;
  let lastSeq: bigint = head?.head_seq ?? 0n;
  const appended: AppendedAuditRow[] = [];

  for (const [i, entry] of entries.entries()) {
    const seq = seqRows[i]!.seq;
    const row: AuditRowForHash = {
      id: newId(),
      tenant_id: tenantId,
      seq,
      actor_kind: ctx.actor.kind,
      actor_id: ctx.actor.id ?? null,
      on_behalf_of: entry.onBehalfOf ?? null,
      device_id: entry.deviceId ?? ctx.actor.deviceId ?? null,
      location_id: entry.locationId ?? ctx.actor.locationId ?? null,
      action: entry.action,
      resource_kind: entry.resourceKind,
      resource_id: entry.resourceId ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      reason: entry.reason ?? null,
      approval_id: entry.approvalId ?? null,
      correlation_id: ctx.correlationId ?? null,
      occurred_at: new Date(),
    };
    const hash = auditHash(prevHash, row);
    await db.query(
      `INSERT INTO audit.audit_log
         (id, tenant_id, seq, actor_kind, actor_id, on_behalf_of, device_id, location_id, action,
          resource_kind, resource_id, before, after, reason, approval_id, correlation_id, ip,
          prev_hash, hash, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        row.id,
        tenantId,
        seq,
        row.actor_kind,
        row.actor_id,
        row.on_behalf_of,
        row.device_id,
        row.location_id,
        row.action,
        row.resource_kind,
        row.resource_id,
        row.before === null ? null : JSON.stringify(row.before),
        row.after === null ? null : JSON.stringify(row.after),
        row.reason,
        row.approval_id,
        row.correlation_id,
        ctx.actor.ip ?? null,
        prevHash,
        hash,
        row.occurred_at,
      ],
    );
    appended.push({ id: row.id, seq, hash, occurredAt: row.occurred_at as Date });
    prevHash = hash;
    lastSeq = seq;
  }

  await db.query(
    `INSERT INTO audit.audit_chain_heads (tenant_id, head_hash, head_seq, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (tenant_id) DO UPDATE SET head_hash = EXCLUDED.head_hash, head_seq = EXCLUDED.head_seq, updated_at = now()`,
    [tenantId, prevHash, lastSeq],
  );
  return appended;
}
