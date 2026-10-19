import { Inject, Injectable } from '@nestjs/common';
import type { TenantScopedDb } from '@pos/db';
import type { Redis } from 'ioredis';
import { Secret, TOTP } from 'otpauth';

import { ConflictError, REDIS, UnitOfWork, ValidationError } from '../../kernel/public/index.js';
import { SecretBox } from '../crypto/secret-box.js';
import { UsersService } from '../users/users.service.js';
import { CredentialsRepository } from './credentials.repository.js';

const ISSUER = 'POS';
const PENDING_TTL = 600;

function totpFor(secret: string, label: string): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
}

/** Verify a code with ±1 step tolerance; returns the matching step or null. Pure, testable. */
export function verifyTotpCode(secret: string, code: string, now = Date.now()): number | null {
  const totp = totpFor(secret, 'verify');
  const delta = totp.validate({ token: code, timestamp: now, window: 1 });
  if (delta === null) return null;
  return Math.floor(now / 1000 / 30) + delta;
}

/**
 * RFC 6238 TOTP. The pending secret lives in Redis until the first valid code confirms enrolment;
 * stored secrets are sealed (AES-GCM, AAD = user id). Each (user, step) is accepted once.
 */
@Injectable()
export class TotpService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly users: UsersService,
    private readonly credentials: CredentialsRepository,
    private readonly box: SecretBox,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async beginEnrollment(): Promise<{ otpauthUri: string }> {
    const userId = this.users.currentUserId();
    const tenantId = this.uow.read((db) => Promise.resolve(db.tenantId));
    const user = await this.users.me();
    const secret = new Secret({ size: 20 });
    const totp = totpFor(secret.base32, user.email ?? user.id);
    await this.redis.set(
      `totp:pending:${await tenantId}:${userId}`,
      secret.base32,
      'EX',
      PENDING_TTL,
    );
    return { otpauthUri: totp.toString() };
  }

  async confirmEnrollment(code: string): Promise<void> {
    const userId = this.users.currentUserId();
    await this.uow.run(async (uow) => {
      const key = `totp:pending:${uow.tenantId}:${userId}`;
      const secret = await this.redis.get(key);
      if (!secret) throw new ConflictError('TOTP_NOT_PENDING', 'Start enrolment first');
      if (verifyTotpCode(secret, code) === null)
        throw new ValidationError({ code: 'invalid code' }, 'Invalid TOTP code');
      await this.redis.del(key);
      await this.credentials.revokeKind(uow.db, userId, 'totp');
      await this.credentials.insert(uow.db, {
        userId,
        kind: 'totp',
        secretHash: this.box.seal(secret, userId),
        label: 'Authenticator app',
      });
      await uow.db.query(
        'UPDATE identity.users SET mfa_enabled = true, updated_at = now() WHERE tenant_id = $1 AND id = $2',
        [uow.tenantId, userId],
      );
      uow.audit({ action: 'identity.totp.enrolled', resourceKind: 'user', resourceId: userId });
    });
  }

  /** Verify against the stored secret with a replay guard. */
  async verify(db: TenantScopedDb, userId: string, code: string): Promise<boolean> {
    const [credential] = await this.credentials.active(db, userId, 'totp');
    if (!credential?.secret_hash) return false;
    const secret = this.box.open(credential.secret_hash, userId);
    const step = verifyTotpCode(secret, code);
    if (step === null) return false;
    const fresh = await this.redis.set(
      `totp:used:${db.tenantId}:${userId}:${step}`,
      '1',
      'EX',
      120,
      'NX',
    );
    if (fresh !== 'OK') return false;
    await this.credentials.touch(db, credential.id);
    return true;
  }
}
