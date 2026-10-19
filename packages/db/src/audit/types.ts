import type { AuditActorKind } from './chain.js';

export interface AuditActor {
  readonly kind: AuditActorKind;
  readonly id?: string | null;
  readonly deviceId?: string | null;
  readonly locationId?: string | null;
  readonly ip?: string | null;
}

/** One audit entry buffered by a unit of work and appended at commit. */
export interface AuditEntryInput {
  readonly action: string; // e.g. tenancy.config.changed, identity.role.granted
  readonly resourceKind: string;
  readonly resourceId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly reason?: string | null;
  readonly approvalId?: string | null;
  readonly onBehalfOf?: string | null;
  readonly locationId?: string | null;
  readonly deviceId?: string | null;
}

export interface AppendedAuditRow {
  readonly id: string;
  readonly seq: bigint;
  readonly hash: Buffer;
  readonly occurredAt: Date;
}
