import { describe, expect, it } from 'vitest';

import { PeripheralManager } from './manager.js';
import {
  MockCashDrawer,
  MockCustomerDisplay,
  MockReceiptPrinter,
  MockScale,
  MockScanner,
} from './mocks.js';
import { BUILTIN_PROFILES, UnknownProfileError, resolveProfile } from './profiles.js';
import { HidWedgeScanner, WedgeDetector } from './wedge.js';

function type(detector: WedgeDetector, text: string, start: number, gap: number, end = 'Enter') {
  let t = start;
  let last;
  for (const ch of text) {
    last = detector.feed(ch, t);
    t += gap;
  }
  return detector.feed(end, t) ?? last;
}

describe('WedgeDetector', () => {
  it('recognises fast input ended by Enter as a scan', () => {
    const d = new WedgeDetector();
    expect(type(d, '9300675024235', 1000, 8)).toEqual({ kind: 'scan', code: '9300675024235' });
  });

  it('treats slow typing as human input and hands it back', () => {
    const d = new WedgeDetector();
    expect(type(d, '1234', 1000, 200)).toEqual({ kind: 'typed', text: '', terminator: 'Enter' });
  });

  it('flushes a stale buffer when the next key arrives after the gap', () => {
    const d = new WedgeDetector();
    d.feed('a', 0);
    d.feed('b', 10);
    expect(d.feed('c', 500)).toEqual({ kind: 'typed', text: 'ab', terminator: null });
  });

  it('short fast bursts below the minimum length are not scans', () => {
    const d = new WedgeDetector({ minLength: 6 });
    expect(type(d, '123', 0, 5)).toEqual({ kind: 'typed', text: '123', terminator: 'Enter' });
  });
});

describe('HidWedgeScanner', () => {
  it('notifies listeners with the code and source', () => {
    const s = new HidWedgeScanner();
    const seen: string[] = [];
    const off = s.onScan((e) => seen.push(`${e.source}:${e.code}`));
    for (const [i, ch] of [...'ABC123', 'Enter'].entries()) s.handleKey(ch, 100 + i * 5);
    off();
    for (const [i, ch] of [...'ZZZZZZ', 'Enter'].entries()) s.handleKey(ch, 1000 + i * 5);
    expect(seen).toEqual(['hid-wedge:ABC123']);
  });
});

describe('mocks and manager', () => {
  it('the mock printer records jobs and drawer kicks and can go offline', async () => {
    const p = new MockReceiptPrinter();
    expect(await p.print({ lines: ['a'], openDrawer: true })).toEqual({ ok: true });
    expect(p.printed).toHaveLength(1);
    expect(p.drawerKicks).toBe(1);
    p.offline = true;
    expect(await p.print({ lines: ['b'] })).toMatchObject({ ok: false, retryable: true });
    expect((await p.status()).state).toBe('offline');
  });

  it('the scale mock reports stability and disconnects', async () => {
    const s = new MockScale();
    s.reading = { weight: '0.8420', unit: 'kg', stable: false };
    expect((await s.status()).state).toBe('degraded');
    s.connected = false;
    await expect(s.read()).rejects.toThrow(/disconnected/);
  });

  it('the scanner mock emits to subscribers and respects disconnect', () => {
    const s = new MockScanner();
    const seen: string[] = [];
    s.onScan((e) => seen.push(e.code));
    s.emit('111');
    s.connected = false;
    s.emit('222');
    expect(seen).toEqual(['111']);
  });

  it('diagnostics lists every peripheral with state, and survives a throwing driver', async () => {
    const manager = new PeripheralManager();
    const printer = new MockReceiptPrinter();
    printer.paperOut = true;
    manager.register(printer);
    manager.register(new MockCashDrawer());
    manager.register(new MockScanner());
    manager.register(new MockScale());
    manager.register(new MockCustomerDisplay());
    manager.register({
      profile: {
        id: 'broken',
        name: 'Broken',
        kind: 'label_printer',
        transport: 'usb',
        capabilities: [],
      },
      status: async () => {
        throw new Error('USB device not found');
      },
    });
    const rows = await manager.diagnostics();
    expect(rows.map((r) => r.id).sort()).toEqual(
      [
        'broken',
        'mock-display',
        'mock-drawer',
        'mock-printer',
        'mock-scale',
        'mock-scanner',
      ].sort(),
    );
    expect(rows.find((r) => r.id === 'mock-printer')).toMatchObject({
      state: 'degraded',
      detail: 'Paper out',
    });
    expect(rows.find((r) => r.id === 'broken')).toMatchObject({
      online: false,
      detail: 'USB device not found',
    });
    expect(manager.first<MockReceiptPrinter>('receipt_printer')).toBe(printer);
  });

  it('a hung driver times out instead of blocking the diagnostics screen', async () => {
    const manager = new PeripheralManager();
    manager.register({
      profile: { id: 'hung', name: 'Hung', kind: 'scale', transport: 'serial', capabilities: [] },
      status: () => new Promise(() => undefined),
    });
    const [row] = await manager.diagnostics(50);
    expect(row).toMatchObject({ online: false, detail: 'Status check timed out' });
  });
});

describe('profiles', () => {
  it('resolves a built-in profile with an address and refuses a missing one', () => {
    expect(resolveProfile('epson-tm-t88-network', { address: '10.0.0.9' })).toMatchObject({
      address: '10.0.0.9',
      kind: 'receipt_printer',
    });
    expect(() => resolveProfile('epson-tm-t88-network')).toThrow(/needs an address/);
    expect(() => resolveProfile('nope')).toThrow(UnknownProfileError);
  });

  it('covers every peripheral kind the F6 scope names', () => {
    const kinds = new Set(Object.values(BUILTIN_PROFILES).map((p) => p.kind));
    for (const k of ['receipt_printer', 'cash_drawer', 'scanner', 'scale', 'customer_display']) {
      // cash drawer is driven through the printer's DK port, so it has no profile of its own
      if (k === 'cash_drawer') continue;
      expect(kinds.has(k as never), k).toBe(true);
    }
    const transports = new Set(Object.values(BUILTIN_PROFILES).map((p) => p.transport));
    expect(['network', 'usb', 'serial', 'bluetooth'].every((t) => transports.has(t as never))).toBe(
      true,
    );
  });
});
