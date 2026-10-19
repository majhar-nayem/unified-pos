import {
  EscPosPrinter,
  HidWedgeScanner,
  MockCashDrawer,
  MockCustomerDisplay,
  MockReceiptPrinter,
  MockScale,
  MockScanner,
  PeripheralManager,
  resolveProfile,
  type ByteTransport,
  type DeviceProfile,
} from '@pos/hardware';

import { invoke, isTauri } from '../platform/runtime.js';
import type { KeyValueStore } from '../platform/ports.js';

/** Peripheral configuration stored under kv `hardware.config`: `[{ "profile": "epson-tm-t88-network", "address": "10.0.0.5:9100" }]`. */
export interface HardwareConfigEntry {
  readonly profile: string;
  readonly address?: string;
  readonly name?: string;
  readonly instanceId?: string;
}

/** TCP from the webview is impossible, so the byte pipe goes through Rust commands (`tcp_*`, src-tauri/src/tcp.rs). */
export class TauriTcpTransport implements ByteTransport {
  private handle: number | null = null;
  constructor(private readonly address: string) {}
  async open() {
    const [host, port = '9100'] = this.address.split(':');
    this.handle = await invoke<number>('tcp_open', { host, port: Number(port) });
  }
  async write(bytes: Uint8Array) {
    await invoke('tcp_write', { handle: this.handle, bytes: Array.from(bytes) });
  }
  async read(length: number, timeoutMs: number) {
    return Uint8Array.from(
      await invoke<number[]>('tcp_read', { handle: this.handle, length, timeoutMs }),
    );
  }
  async close() {
    if (this.handle !== null) await invoke('tcp_close', { handle: this.handle });
    this.handle = null;
  }
}

export interface HardwareSetup {
  readonly manager: PeripheralManager;
  readonly wedge: HidWedgeScanner;
  /** True when every peripheral is a mock (browser dev, or nothing configured). */
  readonly simulated: boolean;
}

export function createMockHardware(): HardwareSetup {
  const manager = new PeripheralManager();
  manager.register(new MockReceiptPrinter());
  manager.register(new MockCashDrawer());
  manager.register(new MockScanner());
  // A stable 0.842 kg so weighed items (bananas, apples) can be exercised without a physical scale.
  manager.register(new MockScale(undefined, { weight: '0.8420', unit: 'kg', stable: true }));
  manager.register(new MockCustomerDisplay());
  return { manager, wedge: new HidWedgeScanner(), simulated: true };
}

export function readHardwareConfig(kv: KeyValueStore): HardwareConfigEntry[] {
  try {
    const parsed = JSON.parse(kv.get('hardware.config') ?? '[]') as unknown;
    return Array.isArray(parsed) ? (parsed as HardwareConfigEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * Production wiring: only what the register's setup lists. In the browser dev build, or with
 * `VITE_MOCK_HARDWARE=1`, the full mock set is used so every screen is exercisable without devices.
 */
export function createHardware(kv: KeyValueStore): HardwareSetup {
  const useMocks = !isTauri() || import.meta.env.VITE_MOCK_HARDWARE === '1';
  if (useMocks) return createMockHardware();
  const manager = new PeripheralManager();
  const wedge = new HidWedgeScanner();
  for (const entry of readHardwareConfig(kv)) {
    const profile: DeviceProfile = resolveProfile(entry.profile, {
      ...(entry.address ? { address: entry.address } : {}),
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.instanceId ? { instanceId: entry.instanceId } : {}),
    });
    if (
      profile.transport === 'network' &&
      (profile.kind === 'receipt_printer' || profile.kind === 'kitchen_printer')
    )
      manager.register(new EscPosPrinter(profile, (p) => new TauriTcpTransport(p.address!)));
    // USB, serial and Bluetooth drivers need Tauri plugins that are not wired yet (see docs/releases/s-f6a.md).
  }
  return { manager, wedge, simulated: false };
}
