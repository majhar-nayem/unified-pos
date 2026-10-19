// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createServices } from './services.js';
import { createMockHardware } from '../hardware/setup.js';
import { MemorySecretStore, WebCryptoDeviceKeys } from '../platform/keys.js';
import { MemoryKeyValueStore } from '../platform/ports.js';
import { createMemoryStore } from '../store/stores.js';
import { FakeApi } from '../test/fake-api.js';

async function boot(api = new FakeApi()) {
  const code = api.addCode();
  const user = api.addUser('1234', 'Priya Patel');
  const services = await createServices({
    store: createMemoryStore(),
    keys: new WebCryptoDeviceKeys(null),
    secrets: new MemorySecretStore(),
    settings: new MemoryKeyValueStore(),
    fetch: api.fetch,
    hardware: createMockHardware(),
    cfd: null,
    now: api.now,
  });
  await services.session.enroll({ apiBaseUrl: 'http://api.test', code, deviceName: 'R1' });
  return { api, user, services };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('StaffDirectory', () => {
  it('learns the cashier name from /users/me after a PIN login and remembers it for the PIN screen', async () => {
    const { services, user } = await boot();
    await services.session.pinLogin(user.id, '1234');
    await settle();
    expect(services.staff.nameOf(user.id)).toBe('Priya Patel');
    expect((await services.store.replicas.staff()).map((s) => s.displayName)).toEqual([
      'Priya Patel',
    ]);
  });

  it('notifies subscribers when a name arrives', async () => {
    const { services, user } = await boot();
    const versions: number[] = [];
    services.staff.subscribe(() => versions.push(services.staff.getVersion()));
    await services.session.pinLogin(user.id, '1234');
    await settle();
    expect(versions.length).toBeGreaterThan(0);
  });

  it('falls back to a short id when the name cannot be fetched', async () => {
    const api = new FakeApi();
    const code = api.addCode();
    const user = api.addUser('1234', 'Priya Patel');
    const services = await createServices({
      store: createMemoryStore(),
      keys: new WebCryptoDeviceKeys(null),
      secrets: new MemorySecretStore(),
      settings: new MemoryKeyValueStore(),
      // The name lookup fails (offline blip, or a role without access to /users/me).
      fetch: async (url, init) =>
        url.endsWith('/v1/users/me') ? new Response('{}', { status: 503 }) : api.fetch(url, init),
      hardware: createMockHardware(),
      cfd: null,
      now: api.now,
    });
    await services.session.enroll({ apiBaseUrl: 'http://api.test', code, deviceName: 'R1' });
    await services.session.pinLogin(user.id, '1234');
    await settle();
    expect(services.staff.nameOf(user.id)).toBe(`Staff ${user.id.slice(0, 6)}`);
  });
});
