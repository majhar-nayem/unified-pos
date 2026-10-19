// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createServices } from './services.js';
import { createMockHardware } from '../hardware/setup.js';
import { MemorySecretStore, WebCryptoDeviceKeys } from '../platform/keys.js';
import { MemoryKeyValueStore } from '../platform/ports.js';
import { createMemoryStore } from '../store/stores.js';
import { FakeApi } from '../test/fake-api.js';

async function boot(
  extra?: (url: string, init: RequestInit | undefined) => Promise<Response | null>,
) {
  const api = new FakeApi();
  const code = api.addCode();
  const user = api.addUser('1234');
  const fetch = async (url: string, init?: RequestInit) =>
    (await extra?.(url, init)) ?? api.fetch(url, init);
  const services = await createServices({
    store: createMemoryStore(),
    keys: new WebCryptoDeviceKeys(null),
    secrets: new MemorySecretStore(),
    settings: new MemoryKeyValueStore(),
    fetch,
    hardware: createMockHardware(),
    cfd: null,
    now: api.now,
  });
  await services.session.enroll({ apiBaseUrl: 'http://api.test', code, deviceName: 'Register 1' });
  await services.session.pinLogin(user.id, '1234');
  return { api, services };
}

describe('SyncCoordinator', () => {
  it('without server sync endpoints: loads the stub catalogue and keeps commands pending with an honest message', async () => {
    const { services } = await boot();
    await services.log.append('cart.line.add', {});
    await services.sync.syncNow();
    const status = services.sync.getStatus();
    expect(status.replica).toMatchObject({ source: 'stub' });
    expect(status.uploadError).toMatch(/no sync endpoint yet/);
    expect(await services.log.pendingCount()).toBe(1);
    expect(services.connectivity.getState().status).toBe('online');
  });

  it('uploads pending commands in a batch to /v1/sync/batches and marks them acked', async () => {
    const seen: unknown[] = [];
    const { services } = await boot(async (url, init) => {
      if (url.endsWith('/v1/sync/batches')) {
        const batch = JSON.parse(String(init?.body)) as {
          clientBatchId: string;
          deviceId: string;
          commands: { clientCommandId: string }[];
        };
        seen.push(batch);
        return new Response(
          JSON.stringify({
            clientBatchId: batch.clientBatchId,
            outcomes: batch.commands.map((_, i) => ({ status: 'applied', serverSeq: i + 1 })),
          }),
          { status: 200 },
        );
      }
      return null;
    });
    await services.log.append('cart.line.add', { n: 1 });
    await services.log.append('cart.line.add', { n: 2 });
    await services.sync.syncNow();
    expect(seen).toHaveLength(1);
    expect((seen[0] as { commands: unknown[] }).commands).toHaveLength(2);
    expect(await services.log.pendingCount()).toBe(0);
    expect(services.sync.getStatus().uploadError).toBeNull();
  });

  it('offline: reports offline, keeps the replica and the pending commands', async () => {
    const { services, api } = await boot();
    await services.sync.syncNow(); // stub replica
    await services.log.append('cart.line.add', {});
    api.online = false;
    await services.sync.syncNow();
    expect(services.sync.getStatus().replica).toMatchObject({ source: 'offline' });
    expect(services.connectivity.getState().status).toBe('offline');
    expect(await services.log.pendingCount()).toBe(1);
    expect(await services.store.replicas.count('catalog', 'variant')).toBeGreaterThan(0);
  });

  it('does nothing while signed out', async () => {
    const { services } = await boot();
    await services.session.signOut();
    await services.sync.syncNow();
    expect(services.sync.getStatus().replica).toBeNull();
  });

  it('a rejected command is kept for the manager queue and shown in the badge counts', async () => {
    const { services } = await boot(async (url, init) => {
      if (url.endsWith('/v1/sync/batches')) {
        const batch = JSON.parse(String(init?.body)) as {
          clientBatchId: string;
          commands: unknown[];
        };
        return new Response(
          JSON.stringify({
            clientBatchId: batch.clientBatchId,
            outcomes: batch.commands.map(() => ({ status: 'rejected', code: 'LIMIT_EXCEEDED' })),
          }),
          { status: 200 },
        );
      }
      return null;
    });
    await services.log.append('order.void', {});
    await services.sync.syncNow();
    expect((await services.log.rejected()).map((c) => c.type)).toEqual(['order.void']);
    expect(await services.log.pendingCount()).toBe(0);
  });
});
