import { Inject, Injectable } from '@nestjs/common';
import type { CreateUser, InviteUser, UpdateUser, UserDto } from '@pos/contracts';
import { newId, type TenantScopedDb, type TenantUnitOfWork } from '@pos/db';
import type { Redis } from 'ioredis';

import {
  AuthorizationService,
  ConflictError,
  NotFoundError,
  REDIS,
  RequestContextService,
  UnitOfWork,
  ValidationError,
  isOperator,
} from '../../kernel/public/index.js';
import { PasswordHasher } from '../crypto/password-hasher.js';
import { newOpaqueToken, sha256Hex } from '../crypto/random.js';

export interface UserRow {
  id: string;
  tenant_id: string;
  email: string | null;
  display_name: string;
  locale: string | null;
  status: UserDto['status'];
  mfa_enabled: boolean;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export function toUserDto(r: UserRow): UserDto {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    email: r.email,
    displayName: r.display_name,
    locale: r.locale,
    status: r.status,
    mfaEnabled: r.mfa_enabled,
    lastLoginAt: r.last_login_at ? r.last_login_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const INVITE_TTL_SECONDS = 7 * 24 * 3600;

@Injectable()
export class UsersService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly context: RequestContextService,
    private readonly hasher: PasswordHasher,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async list(): Promise<UserDto[]> {
    this.authz.assertAnywhere('identity.user.view');
    return this.uow.read(async (db) =>
      (
        await db.query<UserRow>(
          'SELECT * FROM identity.users WHERE tenant_id = $1 ORDER BY display_name',
          [db.tenantId],
        )
      ).map(toUserDto),
    );
  }

  async get(userId: string): Promise<UserDto> {
    if (!this.isSelf(userId)) this.authz.assertAnywhere('identity.user.view');
    return this.uow.read((db) => this.require(db, userId));
  }

  async me(): Promise<UserDto> {
    return this.get(this.currentUserId());
  }

  async create(input: CreateUser): Promise<UserDto> {
    await this.authz.assert('identity.user.manage');
    return this.uow.run(async (uow) => {
      const id = newId();
      const status = input.password ? 'active' : 'invited';
      const rows = await uow.db.query<UserRow>(
        'INSERT INTO identity.users (id, tenant_id, email, display_name, locale, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [id, uow.tenantId, input.email ?? null, input.displayName, input.locale ?? null, status],
      );
      if (input.password) {
        await uow.db.query(
          "INSERT INTO identity.user_credentials (tenant_id, user_id, kind, secret_hash) VALUES ($1, $2, 'password', $3)",
          [uow.tenantId, id, await this.hasher.hash(input.password)],
        );
      }
      const user = toUserDto(rows[0]!);
      uow.audit({
        action: 'identity.user.created',
        resourceKind: 'user',
        resourceId: id,
        after: { email: user.email, displayName: user.displayName, status },
      });
      return user;
    });
  }

  /** Invite: creates the user in `invited` status and returns a one-time token (7 days). */
  async invite(input: InviteUser): Promise<{ user: UserDto; inviteToken: string }> {
    await this.authz.assert('identity.user.invite');
    return this.uow.run((uow) => this.inviteIn(uow, input));
  }

  /** Used by invite() and by tenant provisioning (first admin). */
  async inviteIn(
    uow: TenantUnitOfWork,
    input: InviteUser,
  ): Promise<{ user: UserDto; inviteToken: string }> {
    const id = newId();
    const rows = await uow.db.query<UserRow>(
      "INSERT INTO identity.users (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'invited') RETURNING *",
      [id, uow.tenantId, input.email, input.displayName],
    );
    const inviteToken = await this.issueInviteToken(uow.tenantId, id);
    const user = toUserDto(rows[0]!);
    uow.audit({
      action: 'identity.user.invited',
      resourceKind: 'user',
      resourceId: id,
      after: { email: user.email, displayName: user.displayName },
    });
    uow.emit({
      type: 'user.invited',
      aggregateKind: 'user',
      aggregateId: id,
      payload: { email: user.email },
    });
    return { user, inviteToken };
  }

  async issueInviteToken(tenantId: string, userId: string): Promise<string> {
    const token = newOpaqueToken();
    await this.redis.set(
      `invite:${sha256Hex(token)}`,
      `${tenantId}:${userId}`,
      'EX',
      INVITE_TTL_SECONDS,
    );
    return token;
  }

  /** Public: accept an invite by setting the first password. Returns the tenant and user ids for the login step. */
  async acceptInvite(
    token: string,
    password: string,
  ): Promise<{ tenantId: string; userId: string }> {
    const key = `invite:${sha256Hex(token)}`;
    const stored = await this.redis.getdel(key);
    if (!stored)
      throw new ValidationError(
        { token: 'invalid or expired invite token' },
        'Invalid or expired invite token',
      );
    const [tenantId, userId] = stored.split(':') as [string, string];
    await this.uow.runAs(tenantId, { kind: 'user', id: userId }, async (uow) => {
      const user = await uow.db.maybeOne<UserRow>(
        "SELECT * FROM identity.users WHERE tenant_id = $1 AND id = $2 AND status = 'invited'",
        [tenantId, userId],
      );
      if (!user)
        throw new ValidationError({ token: 'invite no longer valid' }, 'Invite no longer valid');
      await uow.db.query(
        "INSERT INTO identity.user_credentials (tenant_id, user_id, kind, secret_hash) VALUES ($1, $2, 'password', $3)",
        [tenantId, userId, await this.hasher.hash(password)],
      );
      await uow.db.query(
        "UPDATE identity.users SET status = 'active', updated_at = now() WHERE tenant_id = $1 AND id = $2",
        [tenantId, userId],
      );
      uow.audit({
        action: 'identity.user.activated',
        resourceKind: 'user',
        resourceId: userId,
        before: { status: 'invited' },
        after: { status: 'active' },
      });
      uow.emit({ type: 'user.activated', aggregateKind: 'user', aggregateId: userId, payload: {} });
    });
    return { tenantId, userId };
  }

  async update(userId: string, patch: UpdateUser): Promise<UserDto> {
    await this.authz.assert('identity.user.manage');
    return this.uow.run(async (uow) => {
      const before = await this.require(uow.db, userId);
      const sets: string[] = [];
      const params: unknown[] = [uow.tenantId, userId];
      const push = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      if (patch.email !== undefined) push('email', patch.email);
      if (patch.displayName !== undefined) push('display_name', patch.displayName);
      if (patch.locale !== undefined) push('locale', patch.locale);
      if (patch.status !== undefined) push('status', patch.status);
      if (sets.length === 0) return before;
      const rows = await uow.db.query<UserRow>(
        `UPDATE identity.users SET ${sets.join(', ')}, updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        params,
      );
      const after = toUserDto(rows[0]!);
      if (patch.status === 'deactivated' || patch.status === 'suspended') {
        await uow.db.query(
          'UPDATE identity.auth_sessions SET revoked_at = now(), revoke_reason = $3 WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL',
          [uow.tenantId, userId, `user_${patch.status}`],
        );
      }
      if (patch.status === 'deactivated') {
        await uow.db.query(
          "UPDATE identity.user_credentials SET status = 'revoked' WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'",
          [uow.tenantId, userId],
        );
      }
      uow.audit({
        action: 'identity.user.updated',
        resourceKind: 'user',
        resourceId: userId,
        before,
        after,
      });
      return after;
    });
  }

  async revokeSessions(userId: string, reason = 'admin_revoked'): Promise<{ revoked: number }> {
    if (!this.isSelf(userId)) await this.authz.assert('identity.session.revoke');
    return this.uow.run(async (uow) => {
      await this.require(uow.db, userId);
      const rows = await uow.db.query(
        'UPDATE identity.auth_sessions SET revoked_at = now(), revoke_reason = $3 WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id',
        [uow.tenantId, userId, reason],
      );
      uow.audit({
        action: 'identity.session.revoked',
        resourceKind: 'user',
        resourceId: userId,
        after: { revoked: rows.length, reason },
      });
      return { revoked: rows.length };
    });
  }

  currentUserId(): string {
    const principal = this.context.require().principal;
    if (!principal || isOperator(principal) || principal.kind !== 'user') throw new NotFoundError();
    return principal.subjectId;
  }

  isSelf(userId: string): boolean {
    const principal = this.context.current()?.principal;
    return (
      !!principal &&
      !isOperator(principal) &&
      principal.kind === 'user' &&
      principal.subjectId === userId
    );
  }

  async require(db: TenantScopedDb, userId: string): Promise<UserDto> {
    const row = await db.maybeOne<UserRow>(
      'SELECT * FROM identity.users WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, userId],
    );
    if (!row) throw new NotFoundError();
    return toUserDto(row);
  }

  async findByEmail(db: TenantScopedDb, email: string): Promise<UserRow | null> {
    return db.maybeOne<UserRow>(
      'SELECT * FROM identity.users WHERE tenant_id = $1 AND email = $2',
      [db.tenantId, email],
    );
  }
}

export { ConflictError };
