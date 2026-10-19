import { createPublicKey, verify as verifySignature } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type {
  DeviceChallengeResponse,
  DeviceEnrollRequest,
  DeviceEnrollResponse,
  DeviceLoginRequest,
  TokenPair,
} from '@pos/contracts';
import type { Redis } from 'ioredis';

import {
  NotFoundError,
  REDIS,
  TenantDirectory,
  UnauthorizedError,
  UnitOfWork,
  ValidationError,
} from '../../kernel/public/index.js';
import { DevicesService } from '../../devices/public/index.js';
import { newNonce } from '../crypto/random.js';
import { TokenService } from '../crypto/tokens.js';
import { LoginEventsRepository } from './login-events.repository.js';

const NONCE_TTL = 60;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Normalise a base64 public key (raw 32 bytes or SPKI DER) to SPKI DER. */
export function toSpkiDer(publicKeyBase64: string): Buffer {
  const bytes = Buffer.from(
    publicKeyBase64,
    publicKeyBase64.includes('-') || publicKeyBase64.includes('_') ? 'base64url' : 'base64',
  );
  if (bytes.length === 32) return Buffer.concat([ED25519_SPKI_PREFIX, bytes]);
  if (bytes.length === 44 && bytes.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) return bytes;
  throw new ValidationError(
    { publicKey: 'expected a raw 32-byte Ed25519 key or SPKI DER' },
    'Unsupported device public key',
  );
}

/** Message the device signs: `${nonce}.${deviceId}.${tenantId}` (UTF-8). */
export function deviceChallengeMessage(nonce: string, deviceId: string, tenantId: string): Buffer {
  return Buffer.from(`${nonce}.${deviceId}.${tenantId}`, 'utf8');
}

/**
 * Device-bound sessions (docs/01 §11): enrol with a one-time code + Ed25519 public key, then log in
 * by signing a server nonce. Device tokens are stateless (24 h) and re-checked against enrollment_status.
 */
@Injectable()
export class DeviceAuthService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly tenants: TenantDirectory,
    private readonly devices: DevicesService,
    private readonly tokens: TokenService,
    private readonly events: LoginEventsRepository,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async enroll(input: DeviceEnrollRequest): Promise<DeviceEnrollResponse> {
    const [slug] = input.enrollmentCode.split('.', 1);
    const tenant = await this.tenants.findBySlug(slug!);
    if (!tenant || tenant.status !== 'active')
      throw new NotFoundError('Enrollment code is invalid, used or expired');
    const publicKey = toSpkiDer(input.publicKey);
    const device = await this.uow.runAs(tenant.id, { kind: 'system' }, (uow) =>
      this.devices.enroll(uow, input.enrollmentCode, {
        publicKey,
        name: input.name,
        platform: input.platform,
        appVersion: input.appVersion,
      }),
    );
    return {
      device,
      tokens: await this.issue(tenant.id, device.id, device.locationId, device.registerId),
    };
  }

  async challenge(tenantId: string, deviceId: string): Promise<DeviceChallengeResponse> {
    const nonce = newNonce();
    await this.redis.set(`devchal:${tenantId}:${deviceId}`, nonce, 'EX', NONCE_TTL);
    return { nonce };
  }

  async login(input: DeviceLoginRequest): Promise<TokenPair> {
    const expected = await this.redis.getdel(`devchal:${input.tenantId}:${input.deviceId}`);
    const device = await this.devices.findEnrolled(input.tenantId, input.deviceId);
    const fail = async (outcome: 'bad_credentials' | 'revoked') => {
      await this.uow.runAs(input.tenantId, { kind: 'device', id: input.deviceId }, (uow) =>
        this.events.record(uow.db, { outcome, method: 'device_key', deviceId: input.deviceId }),
      );
      throw new UnauthorizedError('DEVICE_AUTH_FAILED', 'Device authentication failed');
    };
    if (!device || !device.public_key) return fail('revoked');
    if (!expected || expected !== input.nonce) return fail('bad_credentials');
    const key = createPublicKey({ key: device.public_key, format: 'der', type: 'spki' });
    const ok = verifySignature(
      null,
      deviceChallengeMessage(input.nonce, input.deviceId, input.tenantId),
      key,
      Buffer.from(input.signature, 'base64'),
    );
    if (!ok) return fail('bad_credentials');
    await this.uow.runAs(input.tenantId, { kind: 'device', id: input.deviceId }, async (uow) => {
      await this.events.record(uow.db, {
        outcome: 'success',
        method: 'device_key',
        deviceId: input.deviceId,
      });
      await uow.db.query(
        'UPDATE devices.devices SET last_seen_at = now() WHERE tenant_id = $1 AND id = $2',
        [input.tenantId, input.deviceId],
      );
    });
    return this.issue(input.tenantId, device.id, device.location_id, device.register_id);
  }

  private async issue(
    tenantId: string,
    deviceId: string,
    locationId: string,
    _registerId: string | null,
  ): Promise<TokenPair> {
    const access = await this.tokens.sign({
      sub: deviceId,
      tid: tenantId,
      knd: 'device',
      did: deviceId,
      loc: locationId,
      amr: ['devkey'],
      mfa: false,
      av: 0,
    });
    return { accessToken: access.token, expiresIn: access.expiresIn };
  }
}
