import { Injectable } from '@nestjs/common';
import type { TenantScopedDb } from '@pos/db';

import { AuthorizationService, UnitOfWork, ValidationError } from '../../kernel/public/index.js';
import { PasswordHasher } from '../crypto/password-hasher.js';
import { UsersService } from '../users/users.service.js';
import { CredentialsRepository } from './credentials.repository.js';

@Injectable()
export class PasswordService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly users: UsersService,
    private readonly hasher: PasswordHasher,
    private readonly credentials: CredentialsRepository,
  ) {}

  /** Self: must present the current password. Admin (identity.credential.manage): resets without it, sessions revoked. */
  async setPassword(
    userId: string,
    input: { currentPassword?: string; newPassword: string },
  ): Promise<void> {
    const self = this.users.isSelf(userId);
    if (!self) await this.authz.assert('identity.credential.manage');
    await this.uow.run(async (uow) => {
      await this.users.require(uow.db, userId);
      if (self) {
        const ok = await this.verify(uow.db, userId, input.currentPassword ?? '');
        if (!ok)
          throw new ValidationError(
            { currentPassword: 'does not match' },
            'Current password does not match',
          );
      }
      const revoked = await this.credentials.revokeKind(uow.db, userId, 'password');
      await this.credentials.insert(uow.db, {
        userId,
        kind: 'password',
        secretHash: await this.hasher.hash(input.newPassword),
      });
      if (!self) {
        await uow.db.query(
          "UPDATE identity.auth_sessions SET revoked_at = now(), revoke_reason = 'password_reset' WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL",
          [uow.tenantId, userId],
        );
      }
      uow.audit({
        action: self ? 'identity.password.changed' : 'identity.password.reset',
        resourceKind: 'user',
        resourceId: userId,
        after: { revokedCredentials: revoked.length },
      });
    });
  }

  /** Constant-time-ish: always runs an Argon2 verification. */
  async verify(db: TenantScopedDb, userId: string, password: string): Promise<boolean> {
    const [credential] = await this.credentials.active(db, userId, 'password');
    const ok = await this.hasher.verify(credential?.secret_hash, password);
    if (ok && credential) await this.credentials.touch(db, credential.id);
    return ok;
  }
}
