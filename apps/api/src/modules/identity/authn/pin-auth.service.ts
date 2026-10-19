import { Injectable } from '@nestjs/common';
import { CONFIG_KEYS, type PinLoginRequest, type TokenPair } from '@pos/contracts';

import {
  LockedError,
  RequestContextService,
  UnauthorizedError,
  UnitOfWork,
  isOperator,
} from '../../kernel/public/index.js';
import { ConfigService } from '../../tenancy/public/index.js';
import { PinService } from '../credentials/pin.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { LockoutService, type LockoutPolicy } from './lockout.service.js';
import { LoginEventsRepository } from './login-events.repository.js';

const DEVICE_LOCKOUT: LockoutPolicy = { maxAttempts: 50, windowSeconds: 900, lockSeconds: 900 };

/** Staff sign-in on an enrolled device with their per-location PIN → `pos` session bound to the device. */
@Injectable()
export class PinAuthService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly pins: PinService,
    private readonly sessions: SessionsService,
    private readonly lockout: LockoutService,
    private readonly config: ConfigService,
    private readonly events: LoginEventsRepository,
    private readonly context: RequestContextService,
  ) {}

  async login(input: PinLoginRequest): Promise<TokenPair> {
    const ctx = this.context.require();
    const principal = ctx.principal;
    if (!principal || isOperator(principal) || principal.kind !== 'device' || !principal.locationId)
      throw new UnauthorizedError('DEVICE_TOKEN_REQUIRED', 'PIN login requires a device token');
    const tenantId = principal.tenantId;
    const deviceId = principal.subjectId;
    const locationId = principal.locationId;
    const meta = { ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null };
    const userKey = `pin:${tenantId}:${locationId}:${input.userId}`;
    const deviceKey = `pin:dev:${tenantId}:${deviceId}`;

    const locked = Math.max(
      await this.lockout.isLocked(userKey),
      await this.lockout.isLocked(deviceKey),
    );
    if (locked > 0)
      throw new LockedError('PIN locked; try again later', { retryAfterSeconds: locked });

    const outcome = await this.uow.runAs(
      tenantId,
      { kind: 'device', id: deviceId, locationId },
      async (uow): Promise<{ tokens: TokenPair } | { locked: number } | { bad: true }> => {
        const policy = await this.policy(uow.db, locationId);
        const user = await uow.db.maybeOne<{ id: string; status: string }>(
          'SELECT id, status FROM identity.users WHERE tenant_id = $1 AND id = $2',
          [tenantId, input.userId],
        );
        const ok =
          user?.status === 'active' &&
          (await this.pins.verify(uow.db, input.userId, locationId, input.pin));
        if (!ok) {
          const failure = await this.lockout.recordFailure(userKey, policy);
          await this.lockout.recordFailure(deviceKey, DEVICE_LOCKOUT);
          await this.events.record(uow.db, {
            userId: input.userId,
            outcome: failure.lockedForSeconds > 0 ? 'locked' : 'bad_credentials',
            method: 'pin',
            deviceId,
            ...meta,
          });
          if (failure.lockedForSeconds > 0) {
            uow.audit({
              action: 'identity.pin.locked',
              resourceKind: 'user',
              resourceId: input.userId,
              locationId,
              deviceId,
              after: { attempts: failure.attempts, lockSeconds: failure.lockedForSeconds },
            });
            return { locked: failure.lockedForSeconds };
          }
          return { bad: true };
        }
        await this.lockout.clear(userKey);
        const session = await this.sessions.create(uow.db, {
          tenantId,
          userId: input.userId,
          kind: 'pos',
          amr: ['dev', 'pin'],
          mfaVerified: false,
          deviceId,
          locationId,
          ...meta,
        });
        await uow.db.query(
          'UPDATE identity.users SET last_login_at = now() WHERE tenant_id = $1 AND id = $2',
          [tenantId, input.userId],
        );
        await this.events.record(uow.db, {
          userId: input.userId,
          outcome: 'success',
          method: 'pin',
          deviceId,
          ...meta,
        });
        return { tokens: session.tokens };
      },
    );
    if ('locked' in outcome)
      throw new LockedError('PIN locked; try again later', { retryAfterSeconds: outcome.locked });
    if ('bad' in outcome) throw new UnauthorizedError('BAD_CREDENTIALS', 'Invalid PIN');
    return outcome.tokens;
  }

  private async policy(
    db: Parameters<ConfigService['effectiveIn']>[0],
    locationId: string,
  ): Promise<LockoutPolicy> {
    const read = async (key: keyof typeof CONFIG_KEYS) =>
      Number((await this.config.effectiveIn(db, key, 'location', locationId)).value);
    return {
      maxAttempts: await read('identity.pin.max_attempts'),
      windowSeconds: await read('identity.pin.window_seconds'),
      lockSeconds: await read('identity.pin.lock_seconds'),
    };
  }
}
