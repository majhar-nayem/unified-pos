/** In-memory implementations of every peripheral interface: tests, Storybook and the dev shell. */
import type {
  CashDrawer,
  CustomerDisplay,
  CustomerDisplayFrame,
  DeviceProfile,
  PeripheralStatus,
  PrintDocument,
  PrintResult,
  ReceiptPrinter,
  Scale,
  ScaleReading,
  ScanEvent,
  ScanListener,
  Scanner,
} from './types.js';

const defineProfile = (p: DeviceProfile): DeviceProfile => p;

export class MockReceiptPrinter implements ReceiptPrinter {
  readonly printed: PrintDocument[] = [];
  drawerKicks = 0;
  /** Flip to simulate the printer going offline / out of paper. */
  offline = false;
  paperOut = false;

  constructor(
    public readonly profile: DeviceProfile = defineProfile({
      id: 'mock-printer',
      name: 'Mock receipt printer',
      kind: 'receipt_printer',
      transport: 'builtin',
      capabilities: ['print_escpos', 'drawer_kick', 'cutter'],
    }),
  ) {}

  async print(document: PrintDocument): Promise<PrintResult> {
    if (this.offline) return { ok: false, retryable: true, error: 'Printer offline' };
    if (this.paperOut) return { ok: false, retryable: true, error: 'Paper out' };
    this.printed.push(document);
    if (document.openDrawer) this.drawerKicks += 1;
    return { ok: true };
  }

  async kickDrawer(): Promise<PrintResult> {
    if (this.offline) return { ok: false, retryable: true, error: 'Printer offline' };
    this.drawerKicks += 1;
    return { ok: true };
  }

  async status(): Promise<PeripheralStatus> {
    if (this.offline) return { online: false, state: 'offline', detail: 'Printer offline' };
    if (this.paperOut)
      return { online: false, state: 'degraded', detail: 'Paper out', paperOut: true };
    return { online: true, state: 'ready' };
  }
}

/** Kept so earlier imports keep working. */
export const MemoryReceiptPrinter = MockReceiptPrinter;

export class MockCashDrawer implements CashDrawer {
  opens = 0;
  jammed = false;
  constructor(
    public readonly profile: DeviceProfile = defineProfile({
      id: 'mock-drawer',
      name: 'Mock cash drawer (via printer)',
      kind: 'cash_drawer',
      transport: 'builtin',
      capabilities: ['drawer_kick'],
    }),
  ) {}
  async open(): Promise<PrintResult> {
    if (this.jammed) return { ok: false, error: 'Drawer did not respond' };
    this.opens += 1;
    return { ok: true };
  }
  async status(): Promise<PeripheralStatus> {
    return this.jammed
      ? { online: false, state: 'degraded', detail: 'Drawer did not respond' }
      : { online: true, state: 'ready' };
  }
}

export class MockScanner implements Scanner {
  private readonly listeners = new Set<ScanListener>();
  connected = true;
  constructor(
    public readonly profile: DeviceProfile = defineProfile({
      id: 'mock-scanner',
      name: 'Mock scanner',
      kind: 'scanner',
      transport: 'builtin',
      capabilities: ['barcode_scan'],
    }),
    private readonly now: () => number = () => Date.now(),
  ) {}
  /** Test/dev helper: deliver a scan as if the hardware read it. */
  emit(code: string, symbology = 'ean13'): void {
    if (!this.connected) return;
    const event: ScanEvent = { code, symbology, at: this.now(), source: this.profile.id };
    for (const listener of this.listeners) listener(event);
  }
  onScan(listener: ScanListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async status(): Promise<PeripheralStatus> {
    return this.connected
      ? { online: true, state: 'ready' }
      : { online: false, state: 'offline', detail: 'Scanner disconnected' };
  }
}

export class MockScale implements Scale {
  constructor(
    public readonly profile: DeviceProfile = defineProfile({
      id: 'mock-scale',
      name: 'Mock scale',
      kind: 'scale',
      transport: 'builtin',
      capabilities: ['weigh_ntep'],
    }),
    public reading: ScaleReading = { weight: '0.0000', unit: 'kg', stable: true },
    public connected = true,
  ) {}
  async read(): Promise<ScaleReading> {
    if (!this.connected) throw new Error('Scale disconnected');
    return this.reading;
  }
  async status(): Promise<PeripheralStatus> {
    if (!this.connected) return { online: false, state: 'offline', detail: 'Scale disconnected' };
    return this.reading.stable
      ? { online: true, state: 'ready' }
      : { online: true, state: 'degraded', detail: 'Weight not stable' };
  }
}

export class MockCustomerDisplay implements CustomerDisplay {
  frames: CustomerDisplayFrame[] = [];
  constructor(
    public readonly profile: DeviceProfile = defineProfile({
      id: 'mock-display',
      name: 'Mock customer display',
      kind: 'customer_display',
      transport: 'builtin',
      capabilities: ['display_text'],
    }),
  ) {}
  async show(frame: CustomerDisplayFrame): Promise<void> {
    this.frames.push(frame);
  }
  async clear(): Promise<void> {
    this.frames.push({ lines: [] });
  }
  async status(): Promise<PeripheralStatus> {
    return { online: true, state: 'ready' };
  }
}
