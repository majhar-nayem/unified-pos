import type { TenantScopedDb } from '../tenant-scoped-db.js';
import { auditHash, bytesEqual, type AuditRowForHash } from './chain.js';

export interface ChainVerification {
  readonly ok: boolean;
  readonly checked: number;
  /** First seq whose stored hash or prev_hash link does not verify. */
  readonly firstBrokenSeq?: bigint;
  readonly headMatches: boolean;
  readonly headSeq: bigint | null;
}

interface StoredRow extends AuditRowForHash {
  readonly prev_hash: Buffer | null;
  readonly hash: Buffer;
  readonly seq: bigint;
}

/**
 * Recompute the tenant's chain from the first row and compare with stored hashes and the head
 * (docs/02-database-design.md §8: nightly proof job; also exposed as POST /v1/audit/verify).
 */
export async function verifyAuditChain(
  db: TenantScopedDb,
  options: { batchSize?: number } = {},
): Promise<ChainVerification> {
  const batchSize = options.batchSize ?? 1000;
  let prevHash: Buffer | null = null;
  let lastSeq: bigint = -1n;
  let checked = 0;
  let firstBrokenSeq: bigint | undefined;

  outer: for (;;) {
    const rows = await db.query<StoredRow>(
      `SELECT id, tenant_id, seq, actor_kind, actor_id, on_behalf_of, device_id, location_id, action,
              resource_kind, resource_id, before, after, reason, approval_id, correlation_id,
              occurred_at, prev_hash, hash
       FROM audit.audit_log
       WHERE tenant_id = $1 AND seq > $2
       ORDER BY seq
       LIMIT $3`,
      [db.tenantId, lastSeq, batchSize],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      checked += 1;
      const expected = auditHash(prevHash, row);
      if (!bytesEqual(row.prev_hash, prevHash) || !bytesEqual(row.hash, expected)) {
        firstBrokenSeq = row.seq;
        break outer;
      }
      prevHash = row.hash;
      lastSeq = row.seq;
    }
    if (rows.length < batchSize) break;
  }

  const head = await db.maybeOne<{ head_hash: Buffer; head_seq: bigint }>(
    'SELECT head_hash, head_seq FROM audit.audit_chain_heads WHERE tenant_id = $1',
    [db.tenantId],
  );
  const headMatches =
    firstBrokenSeq === undefined &&
    (head === null
      ? checked === 0
      : bytesEqual(head.head_hash, prevHash) && head.head_seq === lastSeq);

  return {
    ok: firstBrokenSeq === undefined && headMatches,
    checked,
    ...(firstBrokenSeq !== undefined ? { firstBrokenSeq } : {}),
    headMatches,
    headSeq: head?.head_seq ?? null,
  };
}
