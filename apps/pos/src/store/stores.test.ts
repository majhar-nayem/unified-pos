// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CommandLog,
  HybridLogicalClock,
  SyncUploader,
  type ChangeRecord,
} from '@pos/sync-protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiClient } from '../api/client.js';
import { STUB_CATALOG_RECORDS, toProduct } from '../catalog/placeholder.js';
import { FakeApi } from '../test/fake-api.js';
import { openNodeSqlite } from '../test/node-sqlite.js';
import { ReplicaLoader } from './replica-loader.js';
import { MIGRATIONS, migrate, readEncryptionMode, recordEncryptionMode } from './schema.js';
import { createMemoryStore, createSqliteStore, type LocalStore } from './stores.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

async function sqliteStore(
  path?: string,
): Promise<{ store: LocalStore; db: ReturnType<typeof openNodeSqlite> }> {
  const db = openNodeSqlite(path);
  cleanup.push(() => db.close());
  await migrate(db);
  return { store: createSqliteStore(db, 'simulated'), db };
}

const variant = (
  id: string,
  version: number,
  extra: Record<string, unknown> = {},
): ChangeRecord => ({
  seq: version * 10,
  stream: 'catalog',
  entity: 'variant',
  entityId: id,
  op: 'upsert',
  version,
  payload: { name: id, defaultPriceMinor: '100', barcodes: [{ code: `code-${id}` }], ...extra },
});

describe('schema', () => {
  it('creates the three table groups and is idempotent', async () => {
    const db = openNodeSqlite();
    cleanup.push(() => db.close());
    expect(await migrate(db)).toEqual({ from: 0, to: MIGRATIONS.at(-1)!.version });
    expect(await migrate(db)).toEqual({ from: 1, to: 1 });
    const tables = (
      await db.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    ).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'replica_records',
        'replica_barcodes',
        'replica_cursors',
        'commands',
        'local_projections',
        'store_meta',
      ]),
    );
  });

  it('records the encryption mode (SQLCipher is simulated until wired)', async () => {
    const { db } = await sqliteStore();
    expect(await readEncryptionMode(db)).toBeNull();
    await recordEncryptionMode(db, 'simulated');
    await recordEncryptionMode(db, 'simulated');
    expect(await readEncryptionMode(db)).toBe('simulated');
  });

  it('rejects an unknown command status at the database level', async () => {
    const { db } = await sqliteStore();
    await expect(
      db.execute(
        "INSERT INTO commands (client_command_id, seq, type, payload, hlc, created_at, status) VALUES ('a', 1, 't', '{}', 'h', 'c', 'bogus')",
      ),
    ).rejects.toThrow();
  });
});

describe.each([
  ['sqlite', async () => (await sqliteStore()).store],
  ['memory', async () => createMemoryStore()],
] as const)('replica store (%s)', (_name, make) => {
  it('upserts by version, ignores stale versions and deletes', async () => {
    const store = await make();
    await store.replicas.apply([variant('a', 2, { name: 'new' })]);
    await store.replicas.apply([variant('a', 1, { name: 'old' })]); // stale, ignored
    await store.replicas.apply([variant('a', 2, { name: 'same version' })]); // equal, ignored
    expect((await store.replicas.get('catalog', 'variant', 'a'))?.payload.name).toBe('new');
    await store.replicas.apply([variant('a', 3, { name: 'newest' })]);
    expect((await store.replicas.get('catalog', 'variant', 'a'))?.payload.name).toBe('newest');
    await store.replicas.apply([{ ...variant('a', 4), op: 'delete', payload: {} }]);
    expect(await store.replicas.get('catalog', 'variant', 'a')).toBeNull();
    expect(await store.replicas.findByBarcode('code-a')).toBeNull();
  });

  it('looks up a variant by barcode and follows barcode changes', async () => {
    const store = await make();
    await store.replicas.apply([variant('a', 1), variant('b', 1)]);
    expect((await store.replicas.findByBarcode('code-b'))?.entityId).toBe('b');
    await store.replicas.apply([variant('b', 2, { barcodes: [{ code: 'new-code' }] })]);
    expect(await store.replicas.findByBarcode('code-b')).toBeNull();
    expect((await store.replicas.findByBarcode('new-code'))?.entityId).toBe('b');
  });

  it('applying the same page twice leaves the same state (crash between apply and cursor)', async () => {
    const store = await make();
    const page = [variant('a', 1), variant('b', 1)];
    await store.replicas.apply(page);
    await store.replicas.apply(page);
    expect(await store.replicas.count('catalog', 'variant')).toBe(2);
  });

  it('remembers staff, most recent first', async () => {
    const store = await make();
    await store.replicas.rememberStaff(
      { userId: 'u1', displayName: 'Priya' },
      '2026-10-18T09:00:00Z',
    );
    await store.replicas.rememberStaff(
      { userId: 'u2', displayName: 'Marco' },
      '2026-10-18T10:00:00Z',
    );
    expect((await store.replicas.staff()).map((s) => s.displayName)).toEqual(['Marco', 'Priya']);
  });

  it('stores projections and lists them in HLC order', async () => {
    const store = await make();
    await store.projections.put('order', 'o2', { n: 2 }, '000000000000002:000000:r');
    await store.projections.put('order', 'o1', { n: 1 }, '000000000000001:000000:r');
    await store.projections.put('order', 'o1', { n: 11 }, '000000000000003:000000:r');
    expect(await store.projections.list('order')).toEqual([{ n: 2 }, { n: 11 }]);
    await store.projections.delete('order', 'o2');
    expect(await store.projections.get('order', 'o2')).toBeNull();
  });
});

describe('command log on SQLite: durability and crash recovery', () => {
  it('survives a restart on the same file: in-flight commands go back to pending and replay once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pos-store-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'pos.db');

    // First process: two commands appended, a batch taken, then the app "crashes".
    const first = await sqliteStore(file);
    const log1 = new CommandLog(first.store.commands, new HybridLogicalClock('reg-1'));
    await log1.init();
    await log1.append('cart.line.add', { variantId: 'a' });
    await log1.append('cart.line.add', { variantId: 'b' });
    await log1.nextBatch('dev-1');
    expect(await first.store.commands.count(['in_flight'])).toBe(2);
    first.db.close();

    // Second process: same file.
    const second = await sqliteStore(file);
    const log2 = new CommandLog(second.store.commands, new HybridLogicalClock('reg-1'));
    expect(await log2.init()).toEqual({ recovered: 2 });
    const third = await log2.append('cart.line.add', { variantId: 'c' });
    expect(third.seq).toBe(3);

    const applied: string[] = [];
    const uploader = new SyncUploader(log2, 'dev-1', async (batch) => ({
      clientBatchId: batch.clientBatchId,
      outcomes: batch.commands.map((c) => {
        applied.push(c.clientCommandId);
        return { status: 'applied' as const, serverSeq: applied.length };
      }),
    }));
    await uploader.drain();
    expect(applied).toHaveLength(3);
    expect(await second.store.commands.count(['acked'])).toBe(3);
    expect((await second.store.commands.list(['acked'])).map((c) => c.payload.variantId)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('round-trips rejected results with their code', async () => {
    const { store } = await sqliteStore();
    const log = new CommandLog(store.commands, new HybridLogicalClock('reg-1'));
    await log.init();
    await log.append('order.void', {});
    const batch = (await log.nextBatch('d'))!;
    await log.applyBatchResult(batch, {
      clientBatchId: batch.clientBatchId,
      outcomes: [{ status: 'rejected', code: 'LIMIT_EXCEEDED', detail: 'void limit' }],
    });
    expect((await log.rejected())[0]?.serverResult).toEqual({
      status: 'rejected',
      code: 'LIMIT_EXCEEDED',
      detail: 'void limit',
    });
  });
});

describe('ReplicaLoader', () => {
  const setup = async () => {
    const api = new FakeApi();
    const store = createMemoryStore();
    return {
      api,
      store,
      loader: new ReplicaLoader(store, new ApiClient('http://api.test', api.fetch)),
    };
  };

  it('falls back to the documented stub when the server has no change feed (404)', async () => {
    const { store, loader } = await setup();
    const result = await loader.sync('token');
    expect(result).toEqual({ source: 'stub', applied: STUB_CATALOG_RECORDS.length });
    expect(await store.replicas.count('catalog', 'variant')).toBeGreaterThan(5);
    expect(await loader.sync('token')).toEqual({ source: 'stub', applied: 0 }); // idempotent
    const hit = await store.replicas.findByBarcode('9300675024235');
    expect(toProduct(hit!)).toMatchObject({ name: 'Oat Milk 1L', priceMinor: 450n });
  });

  it('pulls pages by cursor until hasMore is false and advances the cursor', async () => {
    const { api, store } = await setup();
    const pages = [
      { records: [variant('a', 1)].map((r) => ({ ...r, seq: 1 })), cursor: 1, hasMore: true },
      { records: [variant('b', 1)].map((r) => ({ ...r, seq: 2 })), cursor: 2, hasMore: false },
    ];
    const seen: string[] = [];
    const fetch: typeof api.fetch = async (url, init) => {
      if (url.includes('/sync/feed')) {
        const u = new URL(url);
        if (u.searchParams.get('streams') === 'config')
          return new Response(JSON.stringify({ records: [], cursor: 0, hasMore: false }), {
            status: 200,
          });
        seen.push(u.searchParams.get('cursor')!);
        return new Response(JSON.stringify(pages[seen.length - 1]), { status: 200 });
      }
      return api.fetch(url, init);
    };
    const loader = new ReplicaLoader(store, new ApiClient('http://api.test', fetch));
    const result = await loader.sync('token');
    expect(result).toMatchObject({ source: 'feed', applied: 2 });
    expect(seen).toEqual(['0', '1']);
    expect(await store.cursors.get('catalog')).toBe(2);
    expect(await store.replicas.count('catalog', 'variant')).toBe(2);
  });

  it('keeps the last replica and reports offline when the network is down', async () => {
    const { api, store, loader } = await setup();
    await loader.sync('token');
    api.online = false;
    expect(await loader.sync('token')).toMatchObject({ source: 'offline' });
    expect(await store.replicas.count('catalog', 'variant')).toBeGreaterThan(0);
  });

  it('rejects a malformed page instead of applying it', async () => {
    const { store } = await setup();
    const fetch = async () =>
      new Response(JSON.stringify({ records: [{ nope: true }], cursor: 1 }), { status: 200 });
    const loader = new ReplicaLoader(store, new ApiClient('http://api.test', fetch));
    await expect(loader.sync('t')).rejects.toThrow(/Malformed/);
    expect(await store.replicas.count('catalog', 'variant')).toBe(0);
  });
});
