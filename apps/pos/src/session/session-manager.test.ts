// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';

import { ApiClient } from '../api/client.js';
import { MemoryKeyValueStore } from '../platform/ports.js';
import { MemorySecretStore, WebCryptoDeviceKeys } from '../platform/keys.js';
import { FakeApi, FakeTimers } from '../test/fake-api.js';
import { SessionManager } from './session-manager.js';

function setup(
  api = new FakeApi(),
  shared?: { kv: MemoryKeyValueStore; secrets: MemorySecretStore; keys: WebCryptoDeviceKeys },
) {
  const kv = shared?.kv ?? new MemoryKeyValueStore();
  const secrets = shared?.secrets ?? new MemorySecretStore();
  const keys = shared?.keys ?? new WebCryptoDeviceKeys(null);
  const timers = new FakeTimers(api);
  const manager = new SessionManager({
    keys,
    secrets,
    kv,
    makeClient: (base) => new ApiClient(base, api.fetch),
    now: api.now,
    timers,
    platform: 'macos',
    appVersion: '1.2.3',
  });
  return { api, kv, secrets, keys, timers, manager };
}

async function enrolled(ctx = setup()) {
  const code = ctx.api.addCode();
  const user = ctx.api.addUser('4321');
  await ctx.manager.init();
  const result = await ctx.manager.enroll({
    apiBaseUrl: 'http://api.test',
    code,
    deviceName: 'Register 1',
  });
  expect(result.ok).toBe(true);
  return { ...ctx, user };
}

describe('enrolment', () => {
  it('starts unenrolled, enrols with the keychain public key and persists a non-secret identity', async () => {
    const { manager, kv, api, keys } = setup();
    await manager.init();
    expect(manager.getState()).toEqual({ phase: 'unenrolled', notice: null });
    const code = api.addCode();
    const result = await manager.enroll({
      apiBaseUrl: 'http://api.test',
      code,
      deviceName: ' Register 1 ',
    });
    expect(result.ok).toBe(true);
    const state = manager.getState();
    expect(state.phase).toBe('signed_out');
    expect(JSON.parse(kv.get('identity')!)).toMatchObject({
      tenantId: api.tenantId,
      deviceName: 'Register 1',
      kind: 'pos',
    });
    // Only the public key travels; it is the raw 32 byte key.
    expect(Buffer.from(await keys.ensure(), 'base64')).toHaveLength(32);
    expect(kv.get('identity')).not.toMatch(/private|secret|token/i);
  });

  it('a used or unknown code is reported as invalid, a down server as offline', async () => {
    const { manager, api } = setup();
    await manager.init();
    const code = api.addCode();
    expect(
      (await manager.enroll({ apiBaseUrl: 'x', code: 'acme.NOPENOPENOPE', deviceName: 'R' })).ok,
    ).toBe(false);
    await manager.enroll({ apiBaseUrl: 'x', code, deviceName: 'R' });
    const again = await setup(api).manager.enroll({ apiBaseUrl: 'x', code, deviceName: 'R2' });
    expect(again).toMatchObject({ ok: false, reason: 'invalid_code' });
    api.online = false;
    expect(await manager.enroll({ apiBaseUrl: 'x', code, deviceName: 'R' })).toMatchObject({
      ok: false,
      reason: 'offline',
    });
  });
});

describe('device-bound session', () => {
  it('re-authenticates by signing the server nonce once the device token expires', async () => {
    const ctx = await enrolled();
    const { manager, api, user } = ctx;
    expect(await manager.pinLogin(user.id, '4321')).toEqual({ ok: true });
    expect(api.calls.filter((c) => c.includes('device/login'))).toHaveLength(0); // enrol token still valid
    await manager.signOut();
    api.advance(24 * 3600 * 1000);
    expect(await manager.pinLogin(user.id, '4321')).toEqual({ ok: true });
    expect(api.calls.filter((c) => c.includes('device/login'))).toHaveLength(1);
  });

  it('re-authenticates once when the server rejects a device token the client still thought valid', async () => {
    const ctx = await enrolled();
    const real = ctx.api.fetch;
    let first = true;
    const flaky: typeof real = async (url, init) => {
      if (first && url.includes('/auth/pin')) {
        first = false;
        return new Response(
          JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Token expired' } }),
          { status: 401 },
        );
      }
      return real(url, init);
    };
    const manager = new SessionManager({
      keys: ctx.keys,
      secrets: ctx.secrets,
      kv: ctx.kv,
      makeClient: (base) => new ApiClient(base, flaky),
      now: ctx.api.now,
      timers: ctx.timers,
    });
    await manager.init();
    expect(await manager.pinLogin(ctx.user.id, '4321')).toEqual({ ok: true });
    // A fresh manager has no cached token, so it logs in once to start and once more after the rejection.
    expect(ctx.api.calls.filter((c) => c.includes('device/login'))).toHaveLength(2);
    // The rejected first attempt never reached the fake; the retry did.
    expect(ctx.api.calls.filter((c) => c.includes('/auth/pin'))).toHaveLength(1);
  });

  it('a wrong key cannot log in: the server verifies the signature', async () => {
    const ctx = await enrolled();
    ctx.api.advance(24 * 3600 * 1000);
    await ctx.keys.destroy(); // next ensure() makes a different key pair
    const outcome = await ctx.manager.pinLogin(ctx.user.id, '4321');
    expect(outcome).toMatchObject({ ok: false, reason: 'device_auth_failed' });
    expect(ctx.manager.getState()).toMatchObject({ phase: 'signed_out', deviceAuthFailed: true });
  });

  it('a revoked device wipes its identity and key and shows the revoked notice', async () => {
    const ctx = await enrolled();
    for (const d of ctx.api.devices.values()) d.revoked = true;
    expect(await ctx.manager.pinLogin(ctx.user.id, '4321')).toMatchObject({
      ok: false,
      reason: 'device_revoked',
    });
    expect(ctx.manager.getState()).toEqual({ phase: 'unenrolled', notice: 'revoked' });
    expect(ctx.kv.get('identity')).toBeNull();
  });
});

describe('PIN login and lockout', () => {
  it('bad PIN, then locked with a countdown, then success after the lock expires', async () => {
    const { manager, api, user } = await enrolled();
    expect(await manager.pinLogin(user.id, '0000')).toEqual({ ok: false, reason: 'bad_pin' });
    expect(await manager.pinLogin(user.id, '0000')).toEqual({ ok: false, reason: 'bad_pin' });
    const locked = await manager.pinLogin(user.id, '0000');
    expect(locked).toEqual({ ok: false, reason: 'locked', retryAfterSeconds: 60 });
    const state = manager.getState();
    expect(state.phase === 'signed_out' && state.lockedUntil).toBe(api.now() + 60_000);
    // Even the right PIN is refused while locked.
    expect(await manager.pinLogin(user.id, '4321')).toMatchObject({ ok: false, reason: 'locked' });
    api.advance(61_000);
    expect(await manager.pinLogin(user.id, '4321')).toEqual({ ok: true });
    expect(manager.getState().phase).toBe('signed_in');
  });

  it('reports offline when the server cannot be reached', async () => {
    const { manager, api, user } = await enrolled();
    api.online = false;
    expect(await manager.pinLogin(user.id, '4321')).toMatchObject({ ok: false, reason: 'offline' });
  });
});

describe('refresh', () => {
  it('rotates the refresh token on schedule and keeps the staff signed in', async () => {
    const { manager, api, secrets, timers, user } = await enrolled();
    await manager.pinLogin(user.id, '4321');
    const first = await secrets.get('staff-refresh-token');
    expect(timers.pending.size).toBe(1);
    api.advance(0.8 * 3600 * 1000 + 1);
    await timers.runDue();
    const second = await secrets.get('staff-refresh-token');
    expect(second).not.toBe(first);
    expect(manager.getState().phase).toBe('signed_in');
    expect(timers.pending.size).toBe(1); // next refresh scheduled
  });

  it('stays signed in and retries when the network is down', async () => {
    const { manager, api, timers, user } = await enrolled();
    await manager.pinLogin(user.id, '4321');
    api.online = false;
    api.advance(0.8 * 3600 * 1000 + 1);
    await timers.runDue();
    expect(manager.getState().phase).toBe('signed_in');
    expect(timers.pending.size).toBe(1);
    api.advance(0.25 * 3600 * 1000); // the access token itself has now expired
    expect(await manager.accessToken()).toBeNull(); // expired and cannot refresh: callers go offline
    api.online = true;
    api.advance(31_000);
    await timers.runDue();
    expect(await manager.accessToken()).not.toBeNull();
  });

  it('returns to the PIN screen when the server rejects the refresh token', async () => {
    const { manager, api, secrets, timers, user } = await enrolled();
    await manager.pinLogin(user.id, '4321');
    for (const e of api.refreshTokens.values()) e.revoked = true;
    api.advance(0.8 * 3600 * 1000 + 1);
    await timers.runDue();
    expect(manager.getState()).toMatchObject({ phase: 'signed_out' });
    expect(await secrets.get('staff-refresh-token')).toBeNull();
  });

  it('a replayed (stolen) refresh token revokes the session', async () => {
    const { manager, api, secrets, user } = await enrolled();
    await manager.pinLogin(user.id, '4321');
    const stolen = (await secrets.get('staff-refresh-token'))!;
    await manager.refresh(); // legitimate rotation
    const replay = await new ApiClient('http://api.test', api.fetch)
      .refresh(stolen)
      .catch((e: { code: string }) => e.code);
    expect(replay).toBe('REFRESH_REUSED');
    await manager.refresh();
    expect(manager.getState().phase).toBe('signed_out');
  });
});

describe('restart', () => {
  let ctx: Awaited<ReturnType<typeof enrolled>>;
  beforeEach(async () => {
    ctx = await enrolled();
    await ctx.manager.pinLogin(ctx.user.id, '4321');
  });

  it('resumes the staff session after a restart by rotating the stored refresh token', async () => {
    const second = setup(ctx.api, ctx);
    await second.manager.init();
    expect(second.manager.getState()).toMatchObject({
      phase: 'signed_in',
      staff: { userId: ctx.user.id },
    });
  });

  it('resumes offline within the shift window, but not after it', async () => {
    ctx.api.online = false;
    const resumed = setup(ctx.api, ctx);
    await resumed.manager.init();
    expect(resumed.manager.getState()).toMatchObject({
      phase: 'signed_in',
      staff: { expiresAt: 0 },
    });
    ctx.api.advance(15 * 3600 * 1000);
    const late = setup(ctx.api, ctx);
    await late.manager.init();
    expect(late.manager.getState().phase).toBe('signed_out');
  });

  it('an explicit sign-out forgets the refresh token', async () => {
    await ctx.manager.signOut();
    const next = setup(ctx.api, ctx);
    await next.manager.init();
    expect(next.manager.getState().phase).toBe('signed_out');
  });
});
