import { Injectable } from '@nestjs/common';
import type { LoginResponse } from '@pos/contracts';

import {
  ForbiddenError,
  RequestContextService,
  UnauthorizedError,
  UnitOfWork,
  isOperator,
} from '../../kernel/public/index.js';
import { PasskeyService } from '../credentials/passkey.service.js';
import { TotpService } from '../credentials/totp.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { LockoutService } from './lockout.service.js';
import { LoginEventsRepository } from './login-events.repository.js';

const MFA_LOCKOUT = { maxAttempts: 3, windowSeconds: 300, lockSeconds: 300 };

/** Second factor after a password (preauth token) or step-up inside an existing session. */
@Injectable()
export class MfaService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly totp: TotpService,
    private readonly passkeys: PasskeyService,
    private readonly sessions: SessionsService,
    private readonly lockout: LockoutService,
    private readonly events: LoginEventsRepository,
    private readonly context: RequestContextService,
  ) {}

  async verifyTotp(code: string): Promise<LoginResponse> {
    return this.complete('totp', (db, userId) => this.totp.verify(db, userId, code));
  }

  async passkeyOptions(): Promise<Record<string, unknown>> {
    const { tenantId, userId } = this.subject();
    return this.passkeys.authenticationOptions(tenantId, userId);
  }

  async verifyPasskey(response: Record<string, unknown>): Promise<LoginResponse> {
    return this.complete('passkey', (db, userId) =>
      this.passkeys.verifyAuthentication(db, userId, response),
    );
  }

  private async complete(
    method: 'totp' | 'passkey',
    verify: (db: Parameters<TotpService['verify']>[0], userId: string) => Promise<boolean>,
  ): Promise<LoginResponse> {
    const ctx = this.context.require();
    const { tenantId, userId, principal } = this.subject();
    const meta = { ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null };
    const lockKey = `mfa:${tenantId}:${userId}`;
    if ((await this.lockout.isLocked(lockKey)) > 0)
      throw new ForbiddenError('MFA_LOCKED', 'Too many failed second-factor attempts');

    const outcome = await this.uow.runAs(
      tenantId,
      { kind: 'user', id: userId },
      async (uow): Promise<LoginResponse | { failed: 'locked' | 'invalid' | 'revoked' }> => {
        const ok = await verify(uow.db, userId);
        if (!ok) {
          const failure = await this.lockout.recordFailure(lockKey, MFA_LOCKOUT);
          await this.events.record(uow.db, { userId, outcome: 'mfa_failed', method, ...meta });
          return { failed: failure.lockedForSeconds > 0 ? 'locked' : 'invalid' };
        }
        await this.lockout.clear(lockKey);
        await this.events.record(uow.db, { userId, outcome: 'success', method, ...meta });
        const amr = method === 'totp' ? 'otp' : 'swk';
        if (principal.tokenKind === 'preauth' || !principal.sessionId) {
          const session = await this.sessions.create(uow.db, {
            tenantId,
            userId,
            kind: 'web',
            amr: ['pwd', amr],
            mfaVerified: true,
            ...meta,
          });
          await uow.db.query(
            'UPDATE identity.users SET last_login_at = now() WHERE tenant_id = $1 AND id = $2',
            [tenantId, userId],
          );
          return { status: 'authenticated', tokens: session.tokens };
        }
        const session = await this.sessions.markMfaVerified(uow.db, principal.sessionId, amr);
        if (!session) return { failed: 'revoked' };
        const access = await this.sessions.issueAccess({
          tenantId,
          userId,
          kind: session.kind as 'web' | 'pos',
          amr: session.amr,
          mfaVerified: true,
          deviceId: session.device_id,
          locationId: session.location_id,
          sessionId: session.id,
        });
        return {
          status: 'authenticated',
          tokens: { accessToken: access.token, expiresIn: access.expiresIn },
        };
      },
    );
    if ('failed' in outcome) {
      if (outcome.failed === 'locked')
        throw new ForbiddenError('MFA_LOCKED', 'Too many failed second-factor attempts');
      if (outcome.failed === 'revoked')
        throw new UnauthorizedError('SESSION_REVOKED', 'Session is no longer active');
      throw new UnauthorizedError('MFA_FAILED', 'Second factor did not verify');
    }
    return outcome;
  }

  private subject() {
    const principal = this.context.require().principal;
    if (!principal || isOperator(principal) || principal.kind !== 'user')
      throw new UnauthorizedError();
    return { tenantId: principal.tenantId, userId: principal.subjectId, principal };
  }
}
