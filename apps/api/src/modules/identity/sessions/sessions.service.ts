import { Injectable } from '@nestjs/common';
import type { TokenKind } from '@pos/auth';
import type { TokenPair } from '@pos/contracts';
import { newId, type TenantScopedDb } from '@pos/db';

import { UnauthorizedError, UnitOfWork } from '../../kernel/public/index.js';
import { newRefreshToken, parseRefreshToken, sha256Hex } from '../crypto/random.js';
import { TOKEN_TTL_SECONDS, TokenService } from '../crypto/tokens.js';
import { AssignmentsService } from '../access/assignments.service.js';

export interface SessionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  device_id: string | null;
  location_id: string | null;
  kind: 'web' | 'pos' | 'api';
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  mfa_verified_at: Date | null;
  amr: string[];
}

export interface CreateSessionInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly kind: 'web' | 'pos';
  readonly amr: readonly string[];
  readonly mfaVerified: boolean;
  readonly deviceId?: string | null;
  readonly locationId?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

/** Refresh lifetimes: web 12 h sliding (30 d absolute), pos one shift (14 h). */
const REFRESH_TTL_SECONDS: Record<'web' | 'pos', number> = { web: 12 * 3600, pos: 14 * 3600 };
const WEB_ABSOLUTE_SECONDS = 30 * 24 * 3600;

@Injectable()
export class SessionsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly tokens: TokenService,
    private readonly assignments: AssignmentsService,
  ) {}

  /** Create a session row and issue the first access + refresh token pair (inside the caller's transaction). */
  async create(
    db: TenantScopedDb,
    input: CreateSessionInput,
  ): Promise<{ sessionId: string; tokens: TokenPair }> {
    const sessionId = newId();
    const refreshToken = newRefreshToken(input.tenantId);
    await db.query(
      `INSERT INTO identity.auth_sessions (id, tenant_id, user_id, device_id, location_id, kind, refresh_token_hash, expires_at, ip, user_agent, mfa_verified_at, amr)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' seconds')::interval, $9, $10, $11, $12)`,
      [
        sessionId,
        input.tenantId,
        input.userId,
        input.deviceId ?? null,
        input.locationId ?? null,
        input.kind,
        sha256Hex(refreshToken),
        String(REFRESH_TTL_SECONDS[input.kind]),
        input.ip ?? null,
        input.userAgent ?? null,
        input.mfaVerified ? new Date() : null,
        [...input.amr],
      ],
    );
    const access = await this.issueAccess({ ...input, sessionId });
    return {
      sessionId,
      tokens: { accessToken: access.token, refreshToken, expiresIn: access.expiresIn },
    };
  }

  /** Rotate: the old hash moves to prev_; presenting a prev_ hash again means theft → revoke. */
  async rotate(
    refreshToken: string,
    ctx: { ip?: string | null; userAgent?: string | null },
  ): Promise<TokenPair> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) throw new UnauthorizedError('REFRESH_INVALID', 'Invalid refresh token');
    const next = newRefreshToken(parsed.tenantId);
    // Writes made on a failed attempt (revoking a reused session) must commit, so the outcome is
    // returned from the transaction and the error thrown afterwards.
    const outcome = await this.uow.runAs(
      parsed.tenantId,
      { kind: 'system' },
      async (uow): Promise<{ tokens: TokenPair } | { error: 'reused' | 'invalid' }> => {
        const rows = await uow.db.query<SessionRow>(
          `UPDATE identity.auth_sessions
         SET prev_refresh_token_hash = refresh_token_hash, refresh_token_hash = $3,
             expires_at = LEAST(now() + ($4 || ' seconds')::interval, issued_at + ($5 || ' seconds')::interval),
             ip = COALESCE($6, ip), user_agent = COALESCE($7, user_agent)
         WHERE tenant_id = $1 AND refresh_token_hash = $2 AND revoked_at IS NULL AND expires_at > now()
         RETURNING *`,
          [
            parsed.tenantId,
            parsed.hash,
            sha256Hex(next),
            String(REFRESH_TTL_SECONDS.web),
            String(WEB_ABSOLUTE_SECONDS),
            ctx.ip ?? null,
            ctx.userAgent ?? null,
          ],
        );
        const session = rows[0];
        if (!session) {
          const reused = await uow.db.maybeOne<SessionRow>(
            'SELECT * FROM identity.auth_sessions WHERE tenant_id = $1 AND prev_refresh_token_hash = $2',
            [parsed.tenantId, parsed.hash],
          );
          if (reused && !reused.revoked_at) {
            await uow.db.query(
              "UPDATE identity.auth_sessions SET revoked_at = now(), revoke_reason = 'refresh_reuse' WHERE tenant_id = $1 AND id = $2",
              [parsed.tenantId, reused.id],
            );
            await uow.db.query(
              "INSERT INTO identity.login_events (tenant_id, user_id, outcome, method, ip, user_agent, device_id) VALUES ($1, $2, 'revoked', 'refresh', $3, $4, $5)",
              [
                parsed.tenantId,
                reused.user_id,
                ctx.ip ?? null,
                ctx.userAgent ?? null,
                reused.device_id,
              ],
            );
            uow.audit({
              action: 'identity.session.revoked',
              resourceKind: 'user',
              resourceId: reused.user_id,
              after: { sessionId: reused.id, reason: 'refresh_reuse' },
            });
            return { error: 'reused' };
          }
          return { error: 'invalid' };
        }
        const access = await this.issueAccess({
          tenantId: session.tenant_id,
          userId: session.user_id,
          kind: session.kind as 'web' | 'pos',
          amr: session.amr,
          mfaVerified: session.mfa_verified_at !== null,
          deviceId: session.device_id,
          locationId: session.location_id,
          sessionId: session.id,
        });
        return {
          tokens: { accessToken: access.token, refreshToken: next, expiresIn: access.expiresIn },
        };
      },
    );
    if ('error' in outcome) {
      if (outcome.error === 'reused')
        throw new UnauthorizedError(
          'REFRESH_REUSED',
          'Refresh token reuse detected; session revoked',
        );
      throw new UnauthorizedError('REFRESH_INVALID', 'Invalid or expired refresh token');
    }
    return outcome.tokens;
  }

  async revoke(tenantId: string, sessionId: string, reason: string): Promise<void> {
    await this.uow.runAs(tenantId, { kind: 'system' }, async (uow) => {
      const rows = await uow.db.query<{ user_id: string }>(
        'UPDATE identity.auth_sessions SET revoked_at = now(), revoke_reason = $3 WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING user_id',
        [tenantId, sessionId, reason],
      );
      if (rows[0])
        uow.audit({
          action: 'identity.session.revoked',
          resourceKind: 'user',
          resourceId: rows[0].user_id,
          after: { sessionId, reason },
        });
    });
  }

  /** Mark MFA verified on an existing session (step-up) and issue a fresh pair. */
  async markMfaVerified(
    db: TenantScopedDb,
    sessionId: string,
    method: string,
  ): Promise<SessionRow | null> {
    const rows = await db.query<SessionRow>(
      'UPDATE identity.auth_sessions SET mfa_verified_at = now(), amr = array_append(amr, $3) WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING *',
      [db.tenantId, sessionId, method],
    );
    return rows[0] ?? null;
  }

  isActive(db: TenantScopedDb, sessionId: string): Promise<SessionRow | null> {
    return db.maybeOne<SessionRow>(
      'SELECT * FROM identity.auth_sessions WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL AND expires_at > now()',
      [db.tenantId, sessionId],
    );
  }

  async issueAccess(input: {
    tenantId: string;
    userId: string;
    kind: 'web' | 'pos';
    amr: readonly string[];
    mfaVerified: boolean;
    deviceId?: string | null;
    locationId?: string | null;
    sessionId: string;
  }) {
    const av = await this.assignments.currentVersion(input.tenantId, input.userId);
    return this.tokens.sign({
      sub: input.userId,
      tid: input.tenantId,
      knd: input.kind as TokenKind,
      sid: input.sessionId,
      ...(input.deviceId ? { did: input.deviceId } : {}),
      ...(input.locationId ? { loc: input.locationId } : {}),
      amr: [...input.amr],
      mfa: input.mfaVerified,
      av,
    });
  }

  ttl(kind: TokenKind): number {
    return TOKEN_TTL_SECONDS[kind];
  }
}
