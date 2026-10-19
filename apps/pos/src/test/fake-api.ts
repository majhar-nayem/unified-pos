/**
 * In-process fake of the F1 auth API (same wire shapes and error codes as apps/api), used by unit
 * tests. It verifies device signatures with node:crypto, so a wrong challenge message fails here
 * the way it fails against the real server.
 */
import { createPublicKey, randomUUID, verify } from 'node:crypto';

import type { FetchLike } from '../api/client.js';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const b64url = (s: string) => Buffer.from(s).toString('base64url');

export interface FakeUser {
  id: string;
  pin: string;
  displayName: string;
}

export class FakeApi {
  readonly tenantId = randomUUID();
  readonly locationId = randomUUID();
  readonly codes = new Map<string, { used: boolean }>();
  readonly devices = new Map<string, { publicKey: Buffer; revoked: boolean }>();
  readonly users = new Map<string, FakeUser>();
  readonly refreshTokens = new Map<
    string,
    { userId: string; deviceId: string; used: boolean; revoked: boolean }
  >();
  readonly calls: string[] = [];
  /** Failed PIN attempts allowed before a 423. */
  maxAttempts = 3;
  lockSeconds = 60;
  online = true;
  private failures = 0;
  private lockedUntil = 0;
  private nonces = new Map<string, string>();
  private nowMs = Date.now();
  deviceTokenSeconds = 24 * 3600;
  accessSeconds = 3600;

  now = () => this.nowMs;
  advance(ms: number) {
    this.nowMs += ms;
  }

  addUser(pin = '1234', displayName = 'Priya Patel', id: string = randomUUID()): FakeUser {
    const user = { id, pin, displayName };
    this.users.set(user.id, user);
    return user;
  }

  addCode(code = 'acme.ABCDEFGH1234') {
    this.codes.set(code, { used: false });
    return code;
  }

  private token(claims: Record<string, unknown>, ttlSeconds: number) {
    const exp = Math.floor(this.nowMs / 1000) + ttlSeconds;
    return `${b64url('{"alg":"EdDSA"}')}.${b64url(JSON.stringify({ ...claims, exp }))}.sig`;
  }

  private json(status: number, body: unknown) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
  private error(status: number, code: string, message: string, details?: unknown) {
    return this.json(status, { error: { code, message, ...(details ? { details } : {}) } });
  }

  readonly fetch: FetchLike = async (input, init) => {
    if (!this.online) throw new TypeError('fetch failed');
    const url = new URL(input, 'http://fake');
    const path = url.pathname.replace(/^\/v1/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    this.calls.push(`${method} ${path}`);

    if (method === 'POST' && path === '/auth/device/enroll') {
      const code = this.codes.get(body.enrollmentCode ?? '');
      if (!code || code.used)
        return this.error(404, 'NOT_FOUND', 'Enrollment code is invalid, used or expired');
      code.used = true;
      const deviceId = randomUUID();
      const raw = Buffer.from(body.publicKey ?? '', 'base64');
      if (raw.length !== 32)
        return this.error(422, 'VALIDATION_FAILED', 'Unsupported device public key');
      this.devices.set(deviceId, { publicKey: Buffer.concat([SPKI_PREFIX, raw]), revoked: false });
      return this.json(200, {
        device: {
          id: deviceId,
          tenantId: this.tenantId,
          locationId: this.locationId,
          registerId: null,
          kind: 'pos',
          name: body.name,
          platform: body.platform,
          appVersion: body.appVersion,
          enrollmentStatus: 'enrolled',
          enrolledAt: new Date(this.nowMs).toISOString(),
          revokedAt: null,
          lastSeenAt: null,
        },
        tokens: {
          accessToken: this.token(
            { knd: 'device', sub: deviceId, did: deviceId },
            this.deviceTokenSeconds,
          ),
          expiresIn: this.deviceTokenSeconds,
        },
      });
    }

    if (method === 'GET' && path === '/auth/device/challenge') {
      const nonce = randomUUID().replaceAll('-', '');
      this.nonces.set(
        `${url.searchParams.get('tenantId')}:${url.searchParams.get('deviceId')}`,
        nonce,
      );
      return this.json(200, { nonce });
    }

    if (method === 'POST' && path === '/auth/device/login') {
      const key = `${body.tenantId}:${body.deviceId}`;
      const expected = this.nonces.get(key);
      this.nonces.delete(key);
      const device = this.devices.get(body.deviceId ?? '');
      if (!device || device.revoked || expected !== body.nonce)
        return this.error(401, 'DEVICE_AUTH_FAILED', 'Device authentication failed');
      const ok = verify(
        null,
        Buffer.from(`${body.nonce}.${body.deviceId}.${body.tenantId}`),
        createPublicKey({ key: device.publicKey, format: 'der', type: 'spki' }),
        Buffer.from(body.signature ?? '', 'base64'),
      );
      if (!ok) return this.error(401, 'DEVICE_AUTH_FAILED', 'Device authentication failed');
      return this.json(200, {
        accessToken: this.token(
          { knd: 'device', sub: body.deviceId, did: body.deviceId },
          this.deviceTokenSeconds,
        ),
        expiresIn: this.deviceTokenSeconds,
      });
    }

    if (method === 'POST' && path === '/auth/pin') {
      const claims = this.claims(auth);
      const device = claims?.knd === 'device' ? this.devices.get(String(claims.did)) : undefined;
      if (!claims || claims.knd !== 'device')
        return this.error(401, 'UNAUTHORIZED', 'Authentication required');
      if (!device || device.revoked)
        return this.error(401, 'DEVICE_REVOKED', 'Device is not enrolled');
      if (this.lockedUntil > this.nowMs)
        return this.error(423, 'LOCKED', 'PIN locked; try again later', {
          retryAfterSeconds: Math.ceil((this.lockedUntil - this.nowMs) / 1000),
        });
      const user = this.users.get(body.userId ?? '');
      if (!user || user.pin !== body.pin) {
        this.failures += 1;
        if (this.failures >= this.maxAttempts) {
          this.failures = 0;
          this.lockedUntil = this.nowMs + this.lockSeconds * 1000;
          return this.error(423, 'LOCKED', 'PIN locked; try again later', {
            retryAfterSeconds: this.lockSeconds,
          });
        }
        return this.error(401, 'BAD_CREDENTIALS', 'Invalid PIN');
      }
      this.failures = 0;
      return this.json(200, this.issue(user.id, String(claims.did)));
    }

    if (method === 'POST' && path === '/auth/refresh') {
      const entry = this.refreshTokens.get(body.refreshToken ?? '');
      if (!entry) return this.error(401, 'REFRESH_INVALID', 'Invalid or expired refresh token');
      if (entry.used) {
        for (const e of this.refreshTokens.values())
          if (e.userId === entry.userId) e.revoked = true;
        return this.error(401, 'REFRESH_REUSED', 'Refresh token reuse detected; session revoked');
      }
      if (entry.revoked)
        return this.error(401, 'REFRESH_INVALID', 'Invalid or expired refresh token');
      entry.used = true;
      return this.json(200, this.issue(entry.userId, entry.deviceId));
    }

    if (method === 'POST' && path === '/auth/logout') return new Response(null, { status: 204 });

    if (method === 'GET' && path === '/health')
      return this.json(200, {
        status: 'ok',
        service: 'fake-api',
        version: '0',
        time: new Date(this.nowMs).toISOString(),
      });

    if (method === 'GET' && path === '/users/me') {
      const claims = this.claims(auth);
      const user = claims?.knd === 'pos' ? this.users.get(String(claims.sub)) : undefined;
      if (!user) return this.error(401, 'UNAUTHORIZED', 'Authentication required');
      const at = new Date(this.nowMs).toISOString();
      return this.json(200, {
        id: user.id,
        tenantId: this.tenantId,
        email: null,
        displayName: user.displayName,
        locale: null,
        status: 'active',
        mfaEnabled: false,
        lastLoginAt: at,
        createdAt: at,
        updatedAt: at,
      });
    }

    return this.error(404, 'NOT_FOUND', `No route ${method} ${path}`);
  };

  private issue(userId: string, deviceId: string) {
    const refreshToken = `rt_${randomUUID()}`;
    this.refreshTokens.set(refreshToken, { userId, deviceId, used: false, revoked: false });
    return {
      accessToken: this.token({ knd: 'pos', sub: userId, did: deviceId }, this.accessSeconds),
      refreshToken,
      expiresIn: this.accessSeconds,
    };
  }

  private claims(header?: string): Record<string, unknown> | null {
    const token = header?.replace(/^Bearer /, '');
    const part = token?.split('.')[1];
    if (!part) return null;
    try {
      return JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

/** Manual timers so tests can run the scheduled refresh without waiting. */
export class FakeTimers {
  private next = 1;
  readonly pending = new Map<number, { at: number; fn: () => void }>();
  private readonly clock: { now: () => number };
  constructor(clock: { now: () => number }) {
    this.clock = clock;
  }
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.pending.set(id, { at: this.clock.now() + ms, fn });
    return id;
  };
  clearTimeout = (h: unknown): void => {
    this.pending.delete(h as number);
  };
  /** Fire every timer due at or before the clock's current time. */
  async runDue(): Promise<void> {
    for (const [id, t] of [...this.pending]) {
      if (t.at <= this.clock.now()) {
        this.pending.delete(id);
        t.fn();
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }
}
