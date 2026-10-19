/**
 * Device enrolment, device-bound session and staff (PIN) session.
 *
 *   enroll()    one-time code + keychain public key → device identity (non-secret, kv) + device token
 *   deviceToken() 24 h device token, re-obtained by signing a server nonce with the keychain key
 *   pinLogin()  device token + user id + PIN → pos session (60 min access, rotating 14 h refresh)
 *   refresh     scheduled at 80 % of the access lifetime; offline failures keep the staff signed in
 *
 * The class has no React or Tauri imports: ports are injected, so it runs in Vitest.
 */
import type { TokenPair } from '@pos/contracts';

import { ApiError, NetworkError, type ApiClient } from '../api/client.js';
import type { DeviceKeys, KeyValueStore, SecretStore } from '../platform/ports.js';

export interface DeviceIdentity {
  readonly apiBaseUrl: string;
  readonly tenantId: string;
  readonly deviceId: string;
  readonly locationId: string;
  readonly registerId: string | null;
  readonly deviceName: string;
  readonly kind: string;
}

export interface StaffSession {
  readonly userId: string;
  readonly signedInAt: number;
  /** Access token expiry (ms). Expired while offline is allowed: local work continues. */
  readonly expiresAt: number;
}

export type SessionState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'unenrolled'; readonly notice: 'revoked' | null }
  | {
      readonly phase: 'signed_out';
      readonly identity: DeviceIdentity;
      /** Epoch ms until which PIN entry is locked (server 423), else null. */
      readonly lockedUntil: number | null;
      readonly deviceAuthFailed: boolean;
    }
  | {
      readonly phase: 'signed_in';
      readonly identity: DeviceIdentity;
      readonly staff: StaffSession;
    };

export type PinLoginOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'bad_pin' }
  | { readonly ok: false; readonly reason: 'locked'; readonly retryAfterSeconds: number }
  | {
      readonly ok: false;
      readonly reason: 'offline' | 'device_revoked' | 'device_auth_failed' | 'error';
      readonly message: string;
    };

export type EnrollOutcome =
  | { readonly ok: true; readonly identity: DeviceIdentity }
  | {
      readonly ok: false;
      readonly reason: 'invalid_code' | 'offline' | 'error';
      readonly message: string;
    };

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SessionDeps {
  readonly keys: DeviceKeys;
  readonly secrets: SecretStore;
  readonly kv: KeyValueStore;
  readonly makeClient: (baseUrl: string) => ApiClient;
  readonly now?: () => number;
  readonly timers?: Timers;
  readonly platform?: 'windows' | 'android' | 'ios' | 'macos' | 'linux' | 'web';
  readonly appVersion?: string;
}

const KV_IDENTITY = 'identity';
const KV_STAFF = 'staff';
const SECRET_REFRESH = 'staff-refresh-token';
const DEVICE_TOKEN_SKEW_MS = 60_000;
const REFRESH_FRACTION = 0.8;
const OFFLINE_RETRY_MS = 30_000;
/** Matches the server's pos refresh lifetime (14 h): beyond it an offline resume is refused. */
const OFFLINE_RESUME_WINDOW_MS = 14 * 3600 * 1000;

export function decodeJwtClaims(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) return {};
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export class SessionManager {
  private state: SessionState = { phase: 'loading' };
  private readonly listeners = new Set<() => void>();
  private deviceTokenCache: { token: string; expiresAt: number } | null = null;
  private deviceTokenInFlight: Promise<string> | null = null;
  private staffToken: { token: string; expiresAt: number } | null = null;
  private refreshHandle: unknown = null;
  private lockedUntil: number | null = null;
  private readonly now: () => number;
  private readonly timers: Timers;

  constructor(private readonly deps: SessionDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.timers = deps.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
  }

  // --- observable state (useSyncExternalStore) --------------------------------------------

  getState = (): SessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(state: SessionState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  private client(identity: DeviceIdentity): ApiClient {
    return this.deps.makeClient(identity.apiBaseUrl);
  }

  private identity(): DeviceIdentity | null {
    const s = this.state;
    return s.phase === 'signed_in' || s.phase === 'signed_out' ? s.identity : null;
  }

  // --- start-up ----------------------------------------------------------------------------

  async init(): Promise<void> {
    const raw = this.deps.kv.get(KV_IDENTITY);
    if (!raw) return this.set({ phase: 'unenrolled', notice: null });
    let identity: DeviceIdentity;
    try {
      identity = JSON.parse(raw) as DeviceIdentity;
    } catch {
      return this.set({ phase: 'unenrolled', notice: null });
    }
    const staffRaw = this.deps.kv.get(KV_STAFF);
    const refreshToken = await this.deps.secrets.get(SECRET_REFRESH);
    if (staffRaw && refreshToken) {
      const staff = JSON.parse(staffRaw) as { userId: string; signedInAt: number };
      this.set({ phase: 'signed_out', identity, lockedUntil: null, deviceAuthFailed: false });
      try {
        await this.refreshWith(identity, staff.userId, staff.signedInAt, refreshToken);
        return;
      } catch (error) {
        if (
          error instanceof NetworkError &&
          this.now() - staff.signedInAt < OFFLINE_RESUME_WINDOW_MS
        ) {
          // Offline restart mid-shift: resume locally, refresh when the network is back.
          this.staffToken = null;
          this.set({
            phase: 'signed_in',
            identity,
            staff: { userId: staff.userId, signedInAt: staff.signedInAt, expiresAt: 0 },
          });
          this.scheduleRefresh(OFFLINE_RETRY_MS);
          return;
        }
        await this.clearStaff();
      }
    }
    this.set({ phase: 'signed_out', identity, lockedUntil: null, deviceAuthFailed: false });
  }

  // --- enrolment ---------------------------------------------------------------------------

  async enroll(input: {
    apiBaseUrl: string;
    code: string;
    deviceName: string;
  }): Promise<EnrollOutcome> {
    const client = this.deps.makeClient(input.apiBaseUrl);
    try {
      const publicKey = await this.deps.keys.ensure();
      const response = await client.enrollDevice({
        enrollmentCode: input.code.trim(),
        publicKey,
        name: input.deviceName.trim(),
        platform: this.deps.platform ?? 'web',
        appVersion: this.deps.appVersion ?? '0.0.0',
      });
      const identity: DeviceIdentity = {
        apiBaseUrl: input.apiBaseUrl,
        tenantId: response.device.tenantId,
        deviceId: response.device.id,
        locationId: response.device.locationId,
        registerId: response.device.registerId,
        deviceName: response.device.name,
        kind: response.device.kind,
      };
      this.deps.kv.set(KV_IDENTITY, JSON.stringify(identity));
      this.deviceTokenCache = {
        token: response.tokens.accessToken,
        expiresAt: this.now() + response.tokens.expiresIn * 1000,
      };
      this.set({ phase: 'signed_out', identity, lockedUntil: null, deviceAuthFailed: false });
      return { ok: true, identity };
    } catch (error) {
      if (error instanceof NetworkError)
        return {
          ok: false,
          reason: 'offline',
          message: 'Cannot reach the server. Check the address and the network.',
        };
      if (error instanceof ApiError && (error.status === 404 || error.status === 422))
        return {
          ok: false,
          reason: 'invalid_code',
          message: 'That code is invalid, used or expired. Ask a manager for a new one.',
        };
      return {
        ok: false,
        reason: 'error',
        message: error instanceof Error ? error.message : 'Enrolment failed',
      };
    }
  }

  // --- device session ----------------------------------------------------------------------

  /** A valid device token, signing a fresh server nonce with the keychain key when needed. */
  deviceToken(): Promise<string> {
    const identity = this.identity();
    if (!identity) return Promise.reject(new Error('Device is not enrolled'));
    const cached = this.deviceTokenCache;
    if (cached && cached.expiresAt - this.now() > DEVICE_TOKEN_SKEW_MS)
      return Promise.resolve(cached.token);
    if (!this.deviceTokenInFlight) {
      this.deviceTokenInFlight = this.loginDevice(identity).finally(() => {
        this.deviceTokenInFlight = null;
      });
    }
    return this.deviceTokenInFlight;
  }

  private async loginDevice(identity: DeviceIdentity): Promise<string> {
    const client = this.client(identity);
    const nonce = await client.deviceChallenge(identity.tenantId, identity.deviceId);
    // Message format fixed by the server: `${nonce}.${deviceId}.${tenantId}`.
    const signature = await this.deps.keys.sign(
      `${nonce}.${identity.deviceId}.${identity.tenantId}`,
    );
    const tokens = await client.deviceLogin({
      tenantId: identity.tenantId,
      deviceId: identity.deviceId,
      nonce,
      signature,
    });
    this.deviceTokenCache = {
      token: tokens.accessToken,
      expiresAt: this.now() + tokens.expiresIn * 1000,
    };
    return tokens.accessToken;
  }

  // --- staff session -----------------------------------------------------------------------

  /** Drop the cached device token so the next call signs a fresh server nonce. */
  invalidateDeviceToken(): void {
    this.deviceTokenCache = null;
  }

  async pinLogin(userId: string, pin: string): Promise<PinLoginOutcome> {
    const identity = this.identity();
    if (!identity) return { ok: false, reason: 'error', message: 'Device is not enrolled' };
    const attempt = async () => {
      const deviceToken = await this.deviceToken();
      return this.client(identity).pinLogin(deviceToken, userId, pin);
    };
    try {
      let tokens: TokenPair;
      try {
        tokens = await attempt();
      } catch (error) {
        // The server refused the device token itself (expired, rotated keys): authenticate once more and retry.
        const tokenRejected =
          error instanceof ApiError &&
          error.status === 401 &&
          !['BAD_CREDENTIALS', 'DEVICE_REVOKED', 'DEVICE_AUTH_FAILED', 'LOCKED'].includes(
            error.code,
          );
        if (!tokenRejected) throw error;
        this.invalidateDeviceToken();
        tokens = await attempt();
      }
      await this.startStaff(identity, userId, tokens);
      return { ok: true };
    } catch (error) {
      return this.pinFailure(error);
    }
  }

  private async pinFailure(error: unknown): Promise<PinLoginOutcome> {
    if (error instanceof NetworkError)
      return { ok: false, reason: 'offline', message: 'Cannot reach the server to check the PIN.' };
    if (error instanceof ApiError) {
      if (error.status === 423) {
        const seconds = error.retryAfterSeconds ?? 60;
        this.lockedUntil = this.now() + seconds * 1000;
        const identity = this.identity();
        if (identity)
          this.set({
            phase: 'signed_out',
            identity,
            lockedUntil: this.lockedUntil,
            deviceAuthFailed: false,
          });
        return { ok: false, reason: 'locked', retryAfterSeconds: seconds };
      }
      if (error.code === 'BAD_CREDENTIALS') return { ok: false, reason: 'bad_pin' };
      if (error.code === 'DEVICE_REVOKED') {
        await this.wipe('revoked');
        return {
          ok: false,
          reason: 'device_revoked',
          message: 'This register was removed by an administrator.',
        };
      }
      if (error.code === 'DEVICE_AUTH_FAILED') {
        const identity = this.identity();
        if (identity)
          this.set({ phase: 'signed_out', identity, lockedUntil: null, deviceAuthFailed: true });
        return {
          ok: false,
          reason: 'device_auth_failed',
          message: 'This register could not prove its identity to the server.',
        };
      }
      return { ok: false, reason: 'error', message: error.message };
    }
    return {
      ok: false,
      reason: 'error',
      message: error instanceof Error ? error.message : 'Sign-in failed',
    };
  }

  private async startStaff(
    identity: DeviceIdentity,
    userId: string,
    tokens: TokenPair,
  ): Promise<void> {
    const signedInAt = this.now();
    this.deps.kv.set(KV_STAFF, JSON.stringify({ userId, signedInAt }));
    await this.applyStaffTokens(identity, userId, signedInAt, tokens);
  }

  private async applyStaffTokens(
    identity: DeviceIdentity,
    userId: string,
    signedInAt: number,
    tokens: TokenPair,
  ): Promise<void> {
    if (tokens.refreshToken) await this.deps.secrets.set(SECRET_REFRESH, tokens.refreshToken);
    const expiresAt = this.now() + tokens.expiresIn * 1000;
    this.staffToken = { token: tokens.accessToken, expiresAt };
    this.lockedUntil = null;
    this.set({ phase: 'signed_in', identity, staff: { userId, signedInAt, expiresAt } });
    this.scheduleRefresh(tokens.expiresIn * 1000 * REFRESH_FRACTION);
  }

  private async refreshWith(
    identity: DeviceIdentity,
    userId: string,
    signedInAt: number,
    refreshToken: string,
  ): Promise<void> {
    const tokens = await this.client(identity).refresh(refreshToken);
    await this.applyStaffTokens(identity, userId, signedInAt, tokens);
  }

  private scheduleRefresh(ms: number): void {
    if (this.refreshHandle !== null) this.timers.clearTimeout(this.refreshHandle);
    this.refreshHandle = this.timers.setTimeout(() => void this.refresh(), ms);
  }

  /** Rotate the refresh token. Offline: stay signed in and retry. Rejected: back to the PIN screen. */
  async refresh(): Promise<void> {
    const s = this.state;
    if (s.phase !== 'signed_in') return;
    const refreshToken = await this.deps.secrets.get(SECRET_REFRESH);
    if (!refreshToken) return this.signOut();
    try {
      await this.refreshWith(s.identity, s.staff.userId, s.staff.signedInAt, refreshToken);
    } catch (error) {
      if (error instanceof NetworkError || (error instanceof ApiError && error.status >= 500)) {
        this.scheduleRefresh(OFFLINE_RETRY_MS);
        return;
      }
      // REFRESH_INVALID / REFRESH_REUSED / session revoked: staff must sign in again.
      await this.clearStaff();
      this.set({
        phase: 'signed_out',
        identity: s.identity,
        lockedUntil: null,
        deviceAuthFailed: false,
      });
    }
  }

  /** Access token for API calls, refreshed first if it has expired. Null when offline and expired. */
  async accessToken(): Promise<string | null> {
    if (this.state.phase !== 'signed_in') return null;
    if (!this.staffToken || this.staffToken.expiresAt - this.now() < 5_000) await this.refresh();
    return this.staffToken && this.staffToken.expiresAt > this.now() ? this.staffToken.token : null;
  }

  async signOut(): Promise<void> {
    const identity = this.identity();
    const token = this.staffToken?.token;
    if (identity && token)
      await this.client(identity)
        .logout(token)
        .catch(() => undefined);
    await this.clearStaff();
    if (identity)
      this.set({
        phase: 'signed_out',
        identity,
        lockedUntil: this.lockedUntil,
        deviceAuthFailed: false,
      });
  }

  private async clearStaff(): Promise<void> {
    if (this.refreshHandle !== null) this.timers.clearTimeout(this.refreshHandle);
    this.refreshHandle = null;
    this.staffToken = null;
    this.deps.kv.delete(KV_STAFF);
    await this.deps.secrets.delete(SECRET_REFRESH);
  }

  /** Forget this device (revoked by an admin, or a manager chose to re-enrol). */
  async wipe(reason: 'revoked' | 'manual'): Promise<void> {
    await this.clearStaff();
    this.deviceTokenCache = null;
    this.deps.kv.delete(KV_IDENTITY);
    await this.deps.keys.destroy();
    this.set({ phase: 'unenrolled', notice: reason === 'revoked' ? 'revoked' : null });
  }
}
