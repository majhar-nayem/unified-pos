// @vitest-environment node
import { MockScale, PeripheralManager } from '@pos/hardware';
import {
  CommandLog,
  HybridLogicalClock,
  MemoryCommandLogStore,
  type CommandLogStore,
  type LocalCommand,
} from '@pos/sync-protocol';
import { describe, expect, it } from 'vitest';

import { STUB_CATALOG_RECORDS, toProduct } from '../catalog/placeholder.js';
import { openNodeSqlite } from '../test/node-sqlite.js';
import { migrate } from '../store/schema.js';
import { createMemoryStore, createSqliteStore, type LocalStore } from '../store/stores.js';
import { CartService, cartSubtotalMinor, formatMinor, itemCount, lineTotalMinor } from './cart.js';
import { ScanService } from './scan.js';

async function setup(store: LocalStore = createMemoryStore(), scale?: MockScale) {
  await store.replicas.apply(STUB_CATALOG_RECORDS);
  const log = new CommandLog(store.commands, new HybridLogicalClock('reg-1'));
  await log.init();
  const cart = new CartService(log, store.projections);
  const hardware = new PeripheralManager();
  if (scale) hardware.register(scale);
  const scan = new ScanService(store.replicas, cart, hardware);
  return { store, log, cart, scan };
}

const OAT = '9300675024235';
const BANANAS = '9300675024280';

describe('scan → line', () => {
  it('adds a line from a barcode and merges repeats of the same each-item', async () => {
    const { scan, cart } = await setup();
    expect((await scan.handleScan(OAT)).ok).toBe(true);
    await scan.handleScan(OAT);
    const lines = cart.getCart().lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ name: 'Oat Milk 1L', quantity: '2', unitPriceMinor: '450' });
    expect(itemCount(cart.getCart())).toBe(2);
    expect(cartSubtotalMinor(cart.getCart())).toBe(900n);
  });

  it('reports an unknown barcode without touching the cart or the log', async () => {
    const { scan, cart, log } = await setup();
    expect(await scan.handleScan('0000')).toEqual({ ok: false, reason: 'not_found', code: '0000' });
    expect(cart.getCart().lines).toHaveLength(0);
    expect(await log.pendingCount()).toBe(0);
  });

  it.each([
    ['memory', async () => createMemoryStore()],
    [
      'sqlite',
      async () => {
        const db = openNodeSqlite();
        await migrate(db);
        return createSqliteStore(db, 'simulated');
      },
    ],
  ])(
    'meets the 100 ms scan-to-line budget on the %s store (p95 over 200 scans)',
    async (_n, make) => {
      const { scan } = await setup(await make());
      const codes = STUB_CATALOG_RECORDS.filter(
        (r) => r.entity === 'variant' && (r.payload as { soldBy: string }).soldBy === 'each',
      ).map((r) => (r.payload as { barcodes: { code: string }[] }).barcodes[0]!.code);
      const times: number[] = [];
      for (let i = 0; i < 200; i++) {
        const outcome = await scan.handleScan(codes[i % codes.length]!);
        if (!outcome.ok) throw new Error('scan failed');
        times.push(outcome.elapsedMs);
      }
      times.sort((a, b) => a - b);
      expect(times[Math.floor(times.length * 0.95)]!).toBeLessThan(100);
      expect(times[times.length - 1]!).toBeLessThan(100);
    },
  );
});

describe('weighed items', () => {
  it('needs a stable scale reading', async () => {
    const scale = new MockScale(undefined, { weight: '0.8420', unit: 'kg', stable: false });
    const { scan, cart } = await setup(undefined, scale);
    expect(await scan.handleScan(BANANAS)).toMatchObject({ ok: false, reason: 'needs_weight' });
    scale.reading = { weight: '0.0000', unit: 'kg', stable: true };
    expect(await scan.handleScan(BANANAS)).toMatchObject({ ok: false, reason: 'needs_weight' });
    scale.connected = false;
    expect(await scan.handleScan(BANANAS)).toMatchObject({ ok: false, reason: 'needs_weight' });
    expect(cart.getCart().lines).toHaveLength(0);
  });

  it('adds the weight as quantity; the wireframe example is 0.842 kg @ 3.99 = 3.36', async () => {
    const scale = new MockScale(undefined, { weight: '0.8420', unit: 'kg', stable: true });
    const { scan, cart } = await setup(undefined, scale);
    await scan.handleScan(BANANAS);
    const [line] = cart.getCart().lines;
    expect(line).toMatchObject({ quantity: '0.8420', soldBy: 'weight' });
    expect(formatMinor(lineTotalMinor(line!), 'AUD')).toBe('3.36');
  });

  it('weighed items never merge into one line', async () => {
    const scale = new MockScale(undefined, { weight: '0.5000', unit: 'kg', stable: true });
    const { scan, cart } = await setup(undefined, scale);
    await scan.handleScan(BANANAS);
    await scan.handleScan(BANANAS);
    expect(cart.getCart().lines).toHaveLength(2);
  });
});

describe('command before acknowledgement', () => {
  it('the command is durable in the store before subscribers (the UI) hear about the change', async () => {
    const order: string[] = [];
    const inner = new MemoryCommandLogStore();
    const spy: CommandLogStore = {
      append: async (c: LocalCommand) => {
        await new Promise((r) => setTimeout(r, 5)); // a slow disk
        await inner.append(c);
        order.push('stored');
      },
      get: (id) => inner.get(id),
      list: (s, l) => inner.list(s, l),
      update: (ids, p) => inner.update(ids, p),
      maxSeq: () => inner.maxSeq(),
      count: (s) => inner.count(s),
    };
    const store = { ...createMemoryStore(), commands: spy };
    const { scan, cart } = await setup(store);
    cart.subscribe(() => order.push('ui'));
    await scan.handleScan(OAT);
    expect(order[0]).toBe('stored');
    expect(order.indexOf('ui')).toBeGreaterThan(order.indexOf('stored'));
  });

  it('a failed append leaves the cart unchanged', async () => {
    const store = createMemoryStore();
    const inner = store.commands;
    const failing: CommandLogStore = {
      append: async () => {
        throw new Error('disk full');
      },
      get: (id) => inner.get(id),
      list: (s, l) => inner.list(s, l),
      update: (ids, p) => inner.update(ids, p),
      maxSeq: () => inner.maxSeq(),
      count: (s) => inner.count(s),
    };
    const broken = { ...store, commands: failing };
    const { scan, cart } = await setup(broken);
    await expect(scan.handleScan(OAT)).rejects.toThrow('disk full');
    expect(cart.getCart().lines).toHaveLength(0);
  });
});

describe('recovery after a crash', () => {
  it('rebuilds the open order from the projection and flags it as recovered', async () => {
    const first = await setup();
    await first.scan.handleScan(OAT);
    await first.scan.handleScan('9300675024273');
    // New process: same store, fresh services.
    const log = new CommandLog(first.store.commands, new HybridLogicalClock('reg-1'));
    await log.init();
    const cart = new CartService(log, first.store.projections);
    expect(cart.recovered).toBe(false);
    await cart.recover();
    expect(cart.recovered).toBe(true);
    expect(cart.getCart().lines.map((l) => l.name)).toEqual(['Oat Milk 1L', 'Croissant']);
    cart.dismissRecovered();
    expect(cart.recovered).toBe(false);
  });

  it('a voided order is not recovered', async () => {
    const first = await setup();
    await first.scan.handleScan(OAT);
    await first.cart.voidCart();
    const cart = new CartService(first.log, first.store.projections);
    await cart.recover();
    expect(cart.recovered).toBe(false);
    expect(cart.getCart().lines).toHaveLength(0);
  });

  it('removing a line writes a command and updates the projection', async () => {
    const { scan, cart, store, log } = await setup();
    const outcome = await scan.handleScan(OAT);
    if (!outcome.ok) throw new Error('no line');
    await cart.removeLine(outcome.line.lineId);
    expect(cart.getCart().lines).toHaveLength(0);
    expect((await log.list(['pending'])).map((c) => c.type)).toEqual([
      'cart.line.add',
      'cart.line.remove',
    ]);
    expect((await store.projections.list<{ lines: unknown[] }>('cart'))[0]?.lines).toHaveLength(0);
  });
});

describe('catalog mapping', () => {
  it('maps variant payloads defensively and skips records it cannot price', () => {
    const base = {
      stream: 'catalog' as const,
      entity: 'variant',
      entityId: 'v',
      version: 1,
      seq: 1,
    };
    expect(
      toProduct({ ...base, payload: { name: 'X', defaultPriceMinor: '250', barcodes: ['111'] } }),
    ).toMatchObject({ priceMinor: 250n, barcodes: ['111'] });
    expect(toProduct({ ...base, payload: { name: 'X' } })).toBeNull();
    expect(toProduct({ ...base, payload: { defaultPriceMinor: '250' } })).toBeNull();
    expect(toProduct({ ...base, payload: { name: 'X', defaultPriceMinor: 'abc' } })).toBeNull();
  });
});
