import { Injectable } from '@nestjs/common';
import { type AuditActorKind, verifyAuditChain } from '@pos/db';

import { AuthorizationService, UnitOfWork } from '../kernel/public/index.js';
import type { AuditEntryDto, AuditListQuery, AuditPage } from './audit.contracts.js';

interface AuditRow {
  id: string;
  seq: bigint;
  actor_kind: AuditActorKind;
  actor_id: string | null;
  on_behalf_of: string | null;
  device_id: string | null;
  location_id: string | null;
  action: string;
  resource_kind: string;
  resource_id: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  approval_id: string | null;
  correlation_id: string | null;
  prev_hash: Buffer | null;
  hash: Buffer;
  occurred_at: Date;
}

/** Builds the WHERE clause for the audit list (pure, unit-tested). Every query carries tenant_id = $1. */
export function buildAuditFilter(query: AuditListQuery): { where: string; params: unknown[] } {
  const clauses: string[] = ['tenant_id = $1'];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    clauses.push(sql.replace('?', `$${params.length + 1}`));
  };
  if (query.resourceKind) add('resource_kind = ?', query.resourceKind);
  if (query.resourceId) add('resource_id = ?', query.resourceId);
  if (query.actorId) add('actor_id = ?', query.actorId);
  if (query.action) add('action = ?', query.action);
  if (query.from) add('occurred_at >= ?', query.from);
  if (query.to) add('occurred_at < ?', query.to);
  if (query.cursor !== undefined) add('seq > ?', query.cursor);
  return { where: clauses.join(' AND '), params };
}

@Injectable()
export class AuditQueryService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
  ) {}

  async list(query: AuditListQuery): Promise<AuditPage> {
    await this.authz.assert('audit.view');
    const { where, params } = buildAuditFilter(query);
    const rows = await this.uow.read((db) =>
      db.query<AuditRow>(
        `SELECT id, seq, actor_kind, actor_id, on_behalf_of, device_id, location_id, action, resource_kind, resource_id,
                before, after, reason, approval_id, correlation_id, prev_hash, hash, occurred_at
         FROM audit.audit_log WHERE ${where} ORDER BY seq LIMIT ${query.limit + 1}`,
        [db.tenantId, ...params],
      ),
    );
    const page = rows.slice(0, query.limit).map(toDto);
    const nextCursor = rows.length > query.limit ? page[page.length - 1]!.seq : null;
    return { items: page, nextCursor };
  }

  async head() {
    await this.authz.assert('audit.view');
    const row = await this.uow.read((db) =>
      db.maybeOne<{
        head_seq: bigint;
        head_hash: Buffer;
        anchored_at: Date | null;
        updated_at: Date;
      }>(
        'SELECT head_seq, head_hash, anchored_at, updated_at FROM audit.audit_chain_heads WHERE tenant_id = $1',
        [db.tenantId],
      ),
    );
    return {
      headSeq: row ? Number(row.head_seq) : null,
      headHash: row ? row.head_hash.toString('hex') : null,
      anchoredAt: row?.anchored_at ? row.anchored_at.toISOString() : null,
      updatedAt: row ? row.updated_at.toISOString() : null,
    };
  }
}

@Injectable()
export class AuditVerificationService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
  ) {}

  async verifyChain() {
    await this.authz.assert('audit.verify');
    const result = await this.uow.read((db) => verifyAuditChain(db));
    return {
      ok: result.ok,
      checked: result.checked,
      ...(result.firstBrokenSeq !== undefined
        ? { firstBrokenSeq: Number(result.firstBrokenSeq) }
        : {}),
      headMatches: result.headMatches,
      headSeq: result.headSeq === null ? null : Number(result.headSeq),
    };
  }
}

function toDto(r: AuditRow): AuditEntryDto {
  return {
    id: r.id,
    seq: Number(r.seq),
    actorKind: r.actor_kind,
    actorId: r.actor_id,
    onBehalfOf: r.on_behalf_of,
    deviceId: r.device_id,
    locationId: r.location_id,
    action: r.action,
    resourceKind: r.resource_kind,
    resourceId: r.resource_id,
    before: r.before,
    after: r.after,
    reason: r.reason,
    approvalId: r.approval_id,
    correlationId: r.correlation_id,
    prevHash: r.prev_hash ? r.prev_hash.toString('hex') : null,
    hash: r.hash.toString('hex'),
    occurredAt: r.occurred_at.toISOString(),
  };
}
