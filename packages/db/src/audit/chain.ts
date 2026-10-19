import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical.js';

/**
 * Fields of audit.audit_log that enter the hash, in this fixed order. `ip` and `hash`/`prev_hash`
 * are deliberately excluded (inet normalisation is not reproducible from TypeScript).
 */
export const AUDIT_HASH_FIELDS = [
  'id',
  'tenant_id',
  'seq',
  'actor_kind',
  'actor_id',
  'on_behalf_of',
  'device_id',
  'location_id',
  'action',
  'resource_kind',
  'resource_id',
  'before',
  'after',
  'reason',
  'approval_id',
  'correlation_id',
  'occurred_at',
] as const;

export type AuditActorKind = 'user' | 'device' | 'system' | 'api_client' | 'operator';

export interface AuditRowForHash {
  readonly id: string;
  readonly tenant_id: string;
  readonly seq: bigint | number | string;
  readonly actor_kind: AuditActorKind;
  readonly actor_id: string | null;
  readonly on_behalf_of: string | null;
  readonly device_id: string | null;
  readonly location_id: string | null;
  readonly action: string;
  readonly resource_kind: string;
  readonly resource_id: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string | null;
  readonly approval_id: string | null;
  readonly correlation_id: string | null;
  readonly occurred_at: Date | string;
}

/** Canonical byte string for one row: the hashed fields, normalised. */
export function auditRowCanonical(row: AuditRowForHash): string {
  const picked: Record<string, unknown> = {};
  for (const field of AUDIT_HASH_FIELDS) {
    const value = row[field];
    if (field === 'seq') picked[field] = String(value);
    else if (field === 'occurred_at')
      picked[field] = new Date(value as Date | string).toISOString();
    else picked[field] = value ?? null;
  }
  return canonicalJson(picked);
}

/** hash = sha256(prev_hash ‖ utf8(canonical(row))). Genesis rows use an empty prev. */
export function auditHash(prevHash: Uint8Array | null, row: AuditRowForHash): Buffer {
  const hash = createHash('sha256');
  if (prevHash && prevHash.length > 0) hash.update(prevHash);
  hash.update(auditRowCanonical(row), 'utf8');
  return hash.digest();
}

export function bytesEqual(
  a: Uint8Array | null | undefined,
  b: Uint8Array | null | undefined,
): boolean {
  if (!a || !b) return (a?.length ?? 0) === 0 && (b?.length ?? 0) === 0;
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}
