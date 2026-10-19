import { Injectable } from '@nestjs/common';
import type { LoginRequest, LoginResponse } from '@pos/contracts';

import {
  LockedError,
  RequestContextService,
  TenantDirectory,
  UnauthorizedError,
  UnitOfWork,
} from '../../kernel/public/index.js';
import { EffectivePermissionsService } from '../access/effective-permissions.service.js';
import { CredentialsRepository } from '../credentials/credentials.repository.js';
import { PasswordService } from '../credentials/password.service.js';
import { PasswordHasher } from '../crypto/password-hasher.js';
import { TokenService } from '../crypto/tokens.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { type UserRow, UsersService } from '../users/users.service.js';
import { DEFAULT_LOGIN_LOCKOUT, LockoutService } from './lockout.service.js';
import { LoginEventsRepository } from './login-events.repository.js';

/**
 * Password login state machine (docs/releases/f1.md):
 *   unknown tenant/user → 401 (dummy verify)   bad password → login_events + counter → 423 when locked
 *   password ok, MFA needed, factor enrolled → mfa_required + preauth token
 *   password ok, MFA needed, nothing enrolled → mfa_enrollment_required + preauth token
 *   password ok, no MFA needed → authenticated (web session)
 */
@Injectable()
export class LoginService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly tenants: TenantDirectory,
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly hasher: PasswordHasher,
    private readonly credentials: CredentialsRepository,
    private readonly effective: EffectivePermissionsService,
    private readonly sessions: SessionsService,
    private readonly tokens: TokenService,
    private readonly lockout: LockoutService,
    private readonly events: LoginEventsRepository,
    private readonly context: RequestContextService,
  ) {}

  async login(input: LoginRequest): Promise<LoginResponse> {
    const ctx = this.context.current();
    const meta = { ip: ctx?.ip ?? null, userAgent: ctx?.userAgent ?? null };
    const tenant = await this.tenants.findBySlug(input.tenantSlug);
    if (!tenant || tenant.status !== 'active') {
      await this.hasher.dummyVerify();
      throw new UnauthorizedError('BAD_CREDENTIALS', 'Invalid credentials');
    }
    const user = await this.uow.readAs(tenant.id, (db) => this.users.findByEmail(db, input.email));
    if (!user || user.status !== 'active') {
      await this.hasher.dummyVerify();
      await this.uow.runAs(tenant.id, { kind: 'system' }, (uow) =>
        this.events.record(uow.db, {
          emailTried: input.email,
          outcome: 'bad_credentials',
          method: 'password',
          ...meta,
        }),
      );
      throw new UnauthorizedError('BAD_CREDENTIALS', 'Invalid credentials');
    }

    const lockKey = `login:${tenant.id}:${user.id}`;
    const locked = await this.lockout.isLocked(lockKey);
    if (locked > 0) {
      await this.uow.runAs(tenant.id, { kind: 'user', id: user.id }, (uow) =>
        this.events.record(uow.db, {
          userId: user.id,
          outcome: 'locked',
          method: 'password',
          ...meta,
        }),
      );
      throw new LockedError('Too many failed attempts; try again later', {
        retryAfterSeconds: locked,
      });
    }

    const ok = await this.uow.runAs(tenant.id, { kind: 'user', id: user.id }, (uow) =>
      this.passwords.verify(uow.db, user.id, input.password),
    );
    if (!ok) {
      const failure = await this.lockout.recordFailure(lockKey, DEFAULT_LOGIN_LOCKOUT);
      await this.uow.runAs(tenant.id, { kind: 'user', id: user.id }, async (uow) => {
        await this.events.record(uow.db, {
          userId: user.id,
          outcome: failure.lockedForSeconds > 0 ? 'locked' : 'bad_credentials',
          method: 'password',
          ...meta,
        });
        if (failure.lockedForSeconds > 0)
          uow.audit({
            action: 'identity.user.locked',
            resourceKind: 'user',
            resourceId: user.id,
            after: { attempts: failure.attempts, lockSeconds: failure.lockedForSeconds },
          });
      });
      if (failure.lockedForSeconds > 0)
        throw new LockedError('Too many failed attempts; try again later', {
          retryAfterSeconds: failure.lockedForSeconds,
        });
      throw new UnauthorizedError('BAD_CREDENTIALS', 'Invalid credentials');
    }
    await this.lockout.clear(lockKey);

    const effective = await this.effective.build(tenant.id, user.id);
    if (effective.mfaRequired) {
      return this.uow.runAs(tenant.id, { kind: 'user', id: user.id }, async (uow) => {
        const kinds = await this.credentials.activeKinds(uow.db, user.id);
        const methods = (['totp', 'passkey'] as const).filter((k) => kinds.includes(k));
        await this.events.record(uow.db, {
          userId: user.id,
          outcome: 'mfa_required',
          method: 'password',
          ...meta,
        });
        const preauth = await this.tokens.sign({
          sub: user.id,
          tid: tenant.id,
          knd: 'preauth',
          amr: ['pwd'],
          mfa: false,
          av: effective.version,
        });
        return methods.length > 0
          ? { status: 'mfa_required', preauthToken: preauth.token, methods: [...methods] }
          : { status: 'mfa_enrollment_required', preauthToken: preauth.token };
      });
    }
    return this.uow.runAs(tenant.id, { kind: 'user', id: user.id }, async (uow) => {
      const session = await this.sessions.create(uow.db, {
        tenantId: tenant.id,
        userId: user.id,
        kind: 'web',
        amr: ['pwd'],
        mfaVerified: false,
        ...meta,
      });
      await this.touchLogin(uow.db, user);
      await this.events.record(uow.db, {
        userId: user.id,
        outcome: 'success',
        method: 'password',
        ...meta,
      });
      return { status: 'authenticated', tokens: session.tokens };
    });
  }

  async touchLogin(db: Parameters<UsersService['require']>[0], user: UserRow): Promise<void> {
    await db.query(
      'UPDATE identity.users SET last_login_at = now() WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, user.id],
    );
  }
}
