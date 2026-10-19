import { Injectable } from '@nestjs/common';
import { type AttributeValue, type PermissionKey, type Scope, can } from '@pos/auth';
import type { ApprovalFactor, ApprovalRequestDto, CreateApproval } from '@pos/contracts';
import { canonicalJson, newId, type TenantScopedDb } from '@pos/db';

import {
  AuthorizationService,
  ConflictError,
  ForbiddenError,
  KernelPorts,
  NotFoundError,
  RequestContextService,
  UnitOfWork,
  isOperator,
} from '../../kernel/public/index.js';
import { EffectivePermissionsService } from '../access/effective-permissions.service.js';
import { PasskeyService } from '../credentials/passkey.service.js';
import { PinService } from '../credentials/pin.service.js';
import { sha256Hex } from '../crypto/random.js';

interface ApprovalRow {
  id: string;
  tenant_id: string;
  location_id: string | null;
  kind: string;
  subject_kind: string;
  subject_id: string | null;
  payload: Record<string, unknown>;
  payload_hash: string;
  requested_by: string;
  requested_at: Date;
  device_id: string | null;
  status: ApprovalRequestDto['status'];
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  expires_at: Date;
}

function toDto(r: ApprovalRow): ApprovalRequestDto {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    locationId: r.location_id,
    kind: r.kind,
    subjectKind: r.subject_kind,
    subjectId: r.subject_id,
    payload: r.payload,
    payloadHash: r.payload_hash,
    requestedBy: r.requested_by,
    requestedAt: r.requested_at.toISOString(),
    deviceId: r.device_id,
    status: r.status,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
    decisionNote: r.decision_note,
    expiresAt: r.expires_at.toISOString(),
  };
}

export function payloadHash(payload: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(payload));
}

/**
 * Over-limit actions become approval requests (docs/01 §6.3). The payload names the underlying
 * `permission` and the `attributes` that exceeded a limit; approving requires an approver who holds
 * that permission within limits at the location, authenticated in-band (PIN/passkey) or with an
 * MFA-verified session. Consumption by the subject action needs the matching payload hash.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly context: RequestContextService,
    private readonly effective: EffectivePermissionsService,
    private readonly pins: PinService,
    private readonly passkeys: PasskeyService,
    private readonly ports: KernelPorts,
  ) {}

  async create(input: CreateApproval): Promise<ApprovalRequestDto> {
    const scope: Scope | undefined = input.locationId
      ? { kind: 'location', id: input.locationId }
      : undefined;
    await this.authz.assert('approvals.request', scope);
    const principal = this.context.require().principal!;
    const requestedBy =
      !isOperator(principal) && principal.kind === 'user' ? principal.subjectId : null;
    if (!requestedBy)
      throw new ForbiddenError('USER_REQUIRED', 'Only staff sessions can request approvals');
    return this.uow.run(async (uow) => {
      const id = newId();
      const rows = await uow.db.query<ApprovalRow>(
        `INSERT INTO identity.approval_requests (id, tenant_id, location_id, kind, subject_kind, subject_id, payload, payload_hash, requested_by, device_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
          id,
          uow.tenantId,
          input.locationId ?? null,
          input.kind,
          input.subjectKind,
          input.subjectId ?? null,
          JSON.stringify(input.payload),
          payloadHash(input.payload),
          requestedBy,
          (!isOperator(principal) && principal.deviceId) || null,
        ],
      );
      const dto = toDto(rows[0]!);
      uow.audit({
        action: 'approvals.requested',
        resourceKind: 'approval_request',
        resourceId: id,
        locationId: dto.locationId,
        after: {
          kind: dto.kind,
          subjectKind: dto.subjectKind,
          subjectId: dto.subjectId,
          payloadHash: dto.payloadHash,
        },
      });
      return dto;
    });
  }

  async listPending(
    locationId?: string,
    status: ApprovalRequestDto['status'] = 'pending',
  ): Promise<ApprovalRequestDto[]> {
    if (locationId) await this.authz.assert('approvals.view', { kind: 'location', id: locationId });
    else this.authz.assertAnywhere('approvals.view');
    return this.uow.run(async (uow) => {
      const db = uow.db;
      await this.expirePending(db);
      const rows = await db.query<ApprovalRow>(
        'SELECT * FROM identity.approval_requests WHERE tenant_id = $1 AND status = $2 AND ($3::uuid IS NULL OR location_id = $3) ORDER BY requested_at DESC LIMIT 200',
        [db.tenantId, status, locationId ?? null],
      );
      return rows.map(toDto);
    });
  }

  async get(id: string): Promise<ApprovalRequestDto> {
    return this.uow.read(async (db) => {
      const row = await this.require(db, id);
      await this.authz.assert(
        'approvals.view',
        row.location_id ? { kind: 'location', id: row.location_id } : undefined,
      );
      return toDto(row);
    });
  }

  async decide(
    id: string,
    decision: 'approved' | 'rejected',
    input: { note?: string; factor?: ApprovalFactor },
  ): Promise<ApprovalRequestDto> {
    const principal = this.context.require().principal!;
    if (isOperator(principal) || principal.kind !== 'user')
      throw new ForbiddenError('USER_REQUIRED', 'Only staff can decide approvals');
    let expiredId: string | undefined; // the expiry update must commit before the 409 is thrown
    const result = await this.uow.run(async (uow) => {
      const row = await this.require(uow.db, id);
      if (row.status === 'pending' && row.expires_at.getTime() < Date.now()) {
        await uow.db.query(
          "UPDATE identity.approval_requests SET status = 'expired' WHERE tenant_id = $1 AND id = $2",
          [uow.tenantId, id],
        );
        expiredId = id;
        return toDto({ ...row, status: 'expired' });
      }
      if (row.status !== 'pending')
        throw new ConflictError('APPROVAL_NOT_PENDING', `The approval request is ${row.status}`);
      const scope: Scope | undefined = row.location_id
        ? { kind: 'location', id: row.location_id }
        : undefined;

      // Who is approving: the in-band manager (PIN), or the caller with a passkey / MFA-verified session.
      let approverId = principal.subjectId;
      if (input.factor?.kind === 'pin') {
        if (!row.location_id)
          throw new ForbiddenError(
            'PIN_NEEDS_LOCATION',
            'PIN approval requires a location-scoped request',
          );
        const ok = await this.pins.verify(
          uow.db,
          input.factor.userId,
          row.location_id,
          input.factor.pin,
        );
        if (!ok) throw new ForbiddenError('APPROVER_PIN_INVALID', 'Approver PIN did not verify');
        approverId = input.factor.userId;
      } else if (input.factor?.kind === 'passkey') {
        const ok = await this.passkeys.verifyAuthentication(
          uow.db,
          principal.subjectId,
          input.factor.response,
        );
        if (!ok)
          throw new ForbiddenError('APPROVER_PASSKEY_INVALID', 'Approver passkey did not verify');
      } else if (!principal.mfaVerified) {
        throw new ForbiddenError(
          'APPROVER_FACTOR_REQUIRED',
          'Approving requires a PIN, a passkey, or an MFA-verified session',
        );
      }
      if (approverId === row.requested_by)
        throw new ForbiddenError('SELF_APPROVAL', 'Requests cannot be approved by their requester');

      if (decision === 'approved')
        await this.assertApproverCan(uow.tenantId, approverId, row, scope);
      else this.authz.assertAnywhere('approvals.approve');

      const rows = await uow.db.query<ApprovalRow>(
        'UPDATE identity.approval_requests SET status = $3, decided_by = $4, decided_at = now(), decision_note = $5 WHERE tenant_id = $1 AND id = $2 RETURNING *',
        [uow.tenantId, id, decision, approverId, input.note ?? null],
      );
      const dto = toDto(rows[0]!);
      uow.audit({
        action: `approvals.${decision}`,
        resourceKind: 'approval_request',
        resourceId: id,
        locationId: row.location_id,
        onBehalfOf: approverId !== principal.subjectId ? approverId : null,
        reason: input.note ?? null,
        after: { kind: row.kind, decidedBy: approverId },
      });
      uow.emit({
        type: 'approval.decided',
        aggregateKind: 'approval_request',
        aggregateId: id,
        locationId: row.location_id,
        payload: {
          kind: row.kind,
          status: decision,
          decidedBy: approverId,
          subjectKind: row.subject_kind,
          subjectId: row.subject_id,
        },
      });
      return dto;
    });
    if (expiredId) throw new ConflictError('APPROVAL_EXPIRED', 'The approval request has expired');
    return result;
  }

  /** Called by the subject action (e.g. applying the discount) with the hash of what it is about to do. */
  async consume(id: string, hash: string): Promise<ApprovalRequestDto> {
    return this.uow.run(async (uow) => {
      const row = await this.require(uow.db, id);
      if (row.status !== 'approved')
        throw new ConflictError('APPROVAL_NOT_APPROVED', `The approval request is ${row.status}`);
      if (row.payload_hash !== hash)
        throw new ConflictError(
          'APPROVAL_PAYLOAD_MISMATCH',
          'The action does not match what was approved',
        );
      const rows = await uow.db.query<ApprovalRow>(
        "UPDATE identity.approval_requests SET status = 'consumed' WHERE tenant_id = $1 AND id = $2 RETURNING *",
        [uow.tenantId, id],
      );
      uow.audit({
        action: 'approvals.consumed',
        resourceKind: 'approval_request',
        resourceId: id,
        locationId: row.location_id,
        approvalId: id,
        onBehalfOf: row.decided_by,
      });
      return toDto(rows[0]!);
    });
  }

  private async assertApproverCan(
    tenantId: string,
    approverId: string,
    row: ApprovalRow,
    scope: Scope | undefined,
  ): Promise<void> {
    const effective = await this.effective.build(tenantId, approverId);
    const principal = {
      tenantId,
      subjectId: approverId,
      kind: 'user' as const,
      mfaVerified: true,
      assignmentsVersion: effective.version,
      assignments: effective.assignments,
    };
    const target = scope ?? { kind: 'tenant' as const, id: tenantId };
    const resolved =
      target.kind === 'tenant'
        ? { path: [target] }
        : await this.ports.scopeResolver.resolve(tenantId, target.kind, target.id);
    if (!resolved) throw new NotFoundError();
    const permission = (
      typeof row.payload.permission === 'string' ? row.payload.permission : 'approvals.approve'
    ) as PermissionKey;
    const attributes = (row.payload.attributes ?? {}) as Readonly<Record<string, AttributeValue>>;
    const granted = (perm: PermissionKey, attrs?: Readonly<Record<string, AttributeValue>>) =>
      resolved.path.some(
        (s) => can(principal, perm, s, attrs ? { attributes: attrs } : {}).allowed,
      );
    if (!granted('approvals.approve'))
      throw new ForbiddenError(
        'APPROVER_NOT_PERMITTED',
        'Approver lacks approvals.approve at this location',
      );
    if (!granted(permission, attributes))
      throw new ForbiddenError(
        'APPROVER_NOT_PERMITTED',
        `Approver cannot ${permission} within their own limits`,
      );
  }

  private async expirePending(db: TenantScopedDb): Promise<void> {
    await db
      .query(
        "UPDATE identity.approval_requests SET status = 'expired' WHERE tenant_id = $1 AND status = 'pending' AND expires_at < now()",
        [db.tenantId],
      )
      .catch(() => undefined);
  }

  private async require(db: TenantScopedDb, id: string): Promise<ApprovalRow> {
    const row = await db.maybeOne<ApprovalRow>(
      'SELECT * FROM identity.approval_requests WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, id],
    );
    if (!row) throw new NotFoundError();
    return row;
  }
}
