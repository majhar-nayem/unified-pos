import { Injectable } from '@nestjs/common';
import type { PermissionKey, Scope } from '@pos/auth';

import { ApprovalsService, payloadHash } from '../identity/public/index.js';
import { AuthorizationService, NotFoundError, type Attributes } from '../kernel/public/index.js';

export interface GateInput {
  readonly permission: PermissionKey;
  readonly scope: Scope;
  /** ABAC attributes checked against the caller's limits (discount percent, refund amount, …). */
  readonly attributes?: Attributes;
  /** An approved approval request the caller presents when they lack the permission or exceed a limit. */
  readonly approvalId?: string | undefined;
  /**
   * What the approval must have been requested for. Its hash must equal the stored payload hash,
   * so an approval for another order, line or amount cannot be reused. Convention:
   * `{ permission, attributes?, orderId, orderLineId?, … }`.
   */
  readonly payload: Record<string, unknown>;
}

export interface GateResult {
  /** null when the caller's own permission sufficed. */
  readonly approvalId: string | null;
  /**
   * Burn the approval; returns the approver's user id (null without an approval). Call it AFTER the
   * request has been validated and BEFORE the order transaction opens: consumption commits on its
   * own connection, and holding the order's connection while waiting for a second one could
   * starve the pool.
   */
  consume(): Promise<string | null>;
}

/**
 * "Permission or approval" (docs/03 §5 F4: voids require orders.void or approval). The caller either
 * holds the permission within limits at the order's location, or presents an approval that a
 * manager granted for exactly this action (identity.approvals). Out-of-scope is always 404.
 */
@Injectable()
export class ApprovalGate {
  constructor(
    private readonly authz: AuthorizationService,
    private readonly approvals: ApprovalsService,
  ) {}

  async resolve(input: GateInput): Promise<GateResult> {
    const decision = await this.authz.can(input.permission, input.scope, input.attributes);
    if (decision.allowed) return { approvalId: null, consume: async () => null };
    if (decision.reason === 'out_of_scope') throw new NotFoundError();
    const approvalId = input.approvalId;
    if (!approvalId || decision.reason === 'expired') {
      // throws the precise error: 403 PERMISSION_DENIED, or 409 LIMIT_EXCEEDED so the client can request an approval
      await this.authz.assert(input.permission, input.scope, input.attributes);
      throw new Error('unreachable: assert returned for a denied decision');
    }
    const hash = payloadHash(input.payload);
    return {
      approvalId,
      consume: async () => (await this.approvals.consume(approvalId, hash)).decidedBy,
    };
  }
}
