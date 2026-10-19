import { Inject, Injectable } from '@nestjs/common';
import type { TenantScopedDb } from '@pos/db';
import {
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { Redis } from 'ioredis';

import {
  ConflictError,
  REDIS,
  UnauthorizedError,
  UnitOfWork,
  ValidationError,
} from '../../kernel/public/index.js';
import { UsersService } from '../users/users.service.js';
import { CredentialsRepository } from './credentials.repository.js';

const CHALLENGE_TTL = 120;

export interface WebAuthnConfig {
  readonly rpId: string;
  readonly rpName: string;
  readonly origins: readonly string[];
}

export function webAuthnConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WebAuthnConfig {
  return {
    rpId: env.AUTH_WEBAUTHN_RP_ID ?? 'localhost',
    rpName: env.AUTH_WEBAUTHN_RP_NAME ?? 'POS platform',
    origins: (env.AUTH_WEBAUTHN_ORIGINS ?? 'http://localhost:3001,http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export const WEBAUTHN_CONFIG = Symbol('WEBAUTHN_CONFIG');

/** WebAuthn passkeys via @simplewebauthn/server; challenges in Redis; counters guard against clones. */
@Injectable()
export class PasskeyService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly users: UsersService,
    private readonly credentials: CredentialsRepository,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(WEBAUTHN_CONFIG) private readonly config: WebAuthnConfig,
  ) {}

  async registrationOptions(): Promise<Record<string, unknown>> {
    const user = await this.users.me();
    const existing = await this.uow.read((db) => this.credentials.active(db, user.id, 'passkey'));
    const options = await generateRegistrationOptions({
      rpName: this.config.rpName,
      rpID: this.config.rpId,
      userName: user.email ?? user.id,
      userDisplayName: user.displayName,
      userID: Buffer.from(user.id.replace(/-/g, ''), 'hex'),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({
        id: Buffer.from(c.credential_id!).toString('base64url'),
        transports: (c.transports ?? undefined) as never,
      })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    await this.redis.set(
      `webauthn:reg:${user.tenantId}:${user.id}`,
      options.challenge,
      'EX',
      CHALLENGE_TTL,
    );
    return options as unknown as Record<string, unknown>;
  }

  async verifyRegistration(
    response: Record<string, unknown>,
    label?: string,
  ): Promise<{ credentialId: string }> {
    const userId = this.users.currentUserId();
    return this.uow.run(async (uow) => {
      const key = `webauthn:reg:${uow.tenantId}:${userId}`;
      const challenge = await this.redis.getdel(key);
      if (!challenge)
        throw new ConflictError('PASSKEY_CHALLENGE_MISSING', 'Request registration options first');
      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: response as unknown as RegistrationResponseJSON,
          expectedChallenge: challenge,
          expectedOrigin: [...this.config.origins],
          expectedRPID: this.config.rpId,
          requireUserVerification: false,
        });
      } catch (error) {
        throw new ValidationError(
          { response: error instanceof Error ? error.message : 'invalid' },
          'Passkey registration failed',
        );
      }
      if (!verification.verified)
        throw new ValidationError({ response: 'not verified' }, 'Passkey registration failed');
      const { credential, credentialBackedUp, aaguid } = verification.registrationInfo;
      const row = await this.credentials.insert(uow.db, {
        userId,
        kind: 'passkey',
        credentialId: Buffer.from(credential.id, 'base64url'),
        publicKey: Buffer.from(credential.publicKey),
        signCount: BigInt(credential.counter),
        transports: credential.transports ?? null,
        aaguid: aaguid && aaguid !== '00000000-0000-0000-0000-000000000000' ? aaguid : null,
        backedUp: credentialBackedUp,
        label: label ?? 'Passkey',
      });
      await uow.db.query(
        'UPDATE identity.users SET mfa_enabled = true, updated_at = now() WHERE tenant_id = $1 AND id = $2',
        [uow.tenantId, userId],
      );
      uow.audit({
        action: 'identity.passkey.registered',
        resourceKind: 'user',
        resourceId: userId,
        after: { credentialId: row.id, label: row.label },
      });
      return { credentialId: row.id };
    });
  }

  /** Options for a known user (MFA step-up or approval factor). */
  async authenticationOptions(tenantId: string, userId: string): Promise<Record<string, unknown>> {
    const existing = await this.uow.readAs(tenantId, (db) =>
      this.credentials.active(db, userId, 'passkey'),
    );
    if (existing.length === 0)
      throw new ConflictError('PASSKEY_NOT_ENROLLED', 'No passkey enrolled');
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpId,
      allowCredentials: existing.map((c) => ({
        id: Buffer.from(c.credential_id!).toString('base64url'),
        transports: (c.transports ?? undefined) as never,
      })),
      userVerification: 'preferred',
    });
    await this.redis.set(
      `webauthn:auth:${tenantId}:${userId}`,
      options.challenge,
      'EX',
      CHALLENGE_TTL,
    );
    return options as unknown as Record<string, unknown>;
  }

  /** Verify an assertion inside the caller's transaction; counter regressions revoke the credential. */
  async verifyAuthentication(
    db: TenantScopedDb,
    userId: string,
    response: Record<string, unknown>,
  ): Promise<boolean> {
    const challenge = await this.redis.getdel(`webauthn:auth:${db.tenantId}:${userId}`);
    if (!challenge)
      throw new UnauthorizedError(
        'PASSKEY_CHALLENGE_MISSING',
        'Request authentication options first',
      );
    const assertion = response as unknown as AuthenticationResponseJSON;
    const credential = await this.credentials.byCredentialId(
      db,
      Buffer.from(assertion.id, 'base64url'),
    );
    if (!credential || credential.user_id !== userId || !credential.public_key) return false;
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: assertion,
        expectedChallenge: challenge,
        expectedOrigin: [...this.config.origins],
        expectedRPID: this.config.rpId,
        requireUserVerification: false,
        credential: {
          id: assertion.id,
          publicKey: new Uint8Array(credential.public_key),
          // The library's own counter check throws before this service could react, so the stored
          // counter is withheld here and the regression check below runs after the signature has
          // been verified, where a clone can be revoked rather than merely rejected.
          counter: 0,
          transports: (credential.transports ?? undefined) as never,
        },
      });
    } catch {
      return false;
    }
    if (!verification.verified) return false;
    const newCounter = BigInt(verification.authenticationInfo.newCounter);
    if (credential.sign_count > 0n && newCounter <= credential.sign_count) {
      // A signed assertion with a stale counter means a second copy of the key exists (WebAuthn §6.1.1).
      await this.credentials.revoke(db, [credential.id]);
      return false;
    }
    await this.credentials.touch(db, credential.id, newCounter);
    return true;
  }
}
