import { Injectable } from '@nestjs/common';
import type { TenantScopedDb } from '@pos/db';

import { AuthorizationService, UnitOfWork } from '../../kernel/public/index.js';
import { PasswordHasher } from '../crypto/password-hasher.js';
import { UsersService } from '../users/users.service.js';
import { CredentialsRepository } from './credentials.repository.js';

/** Per-location staff PINs (Argon2id). Setting replaces the active row; history stays revoked. */
@Injectable()
export class PinService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly users: UsersService,
    private readonly hasher: PasswordHasher,
    private readonly credentials: CredentialsRepository,
  ) {}

  async setPin(userId: string, locationId: string, pin: string): Promise<void> {
    if (!this.users.isSelf(userId))
      await this.authz.assert('identity.pin.set', { kind: 'location', id: locationId });
    await this.uow.run(async (uow) => {
      await this.users.require(uow.db, userId);
      const revoked = await this.credentials.revokeKind(uow.db, userId, 'pos_pin', locationId);
      await this.credentials.insert(uow.db, {
        userId,
        kind: 'pos_pin',
        locationId,
        secretHash: await this.hasher.hash(pin),
      });
      uow.audit({
        action: 'identity.pin.set',
        resourceKind: 'user',
        resourceId: userId,
        locationId,
        after: { replaced: revoked.length },
      });
    });
  }

  async verify(
    db: TenantScopedDb,
    userId: string,
    locationId: string,
    pin: string,
  ): Promise<boolean> {
    const [credential] = await this.credentials.active(db, userId, 'pos_pin', locationId);
    const ok = await this.hasher.verify(credential?.secret_hash, pin);
    if (ok && credential) await this.credentials.touch(db, credential.id);
    return ok;
  }
}
