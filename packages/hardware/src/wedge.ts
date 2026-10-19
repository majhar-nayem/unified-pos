/**
 * Keyboard-wedge (HID) scanner detection. A scanner "types" the code very fast and ends with Enter;
 * a human is much slower. The detector works on key events with timestamps and has no DOM
 * dependency, so it is unit-tested directly and wrapped by the POS `useScannerCapture` hook.
 */
import type { DeviceProfile, ScanEvent, ScanListener, Scanner, PeripheralStatus } from './types.js';

export interface WedgeOptions {
  /** Max gap between two characters of one scan. Scanners are < 30 ms; humans > 80 ms. */
  readonly maxGapMs?: number;
  readonly minLength?: number;
  /** Characters that terminate a scan. */
  readonly terminators?: readonly string[];
}

export type WedgeResult =
  | { readonly kind: 'scan'; readonly code: string }
  /** Keystrokes that turned out to be human typing: hand them back so a text field can receive them. */
  | { readonly kind: 'typed'; readonly text: string; readonly terminator: string | null }
  | { readonly kind: 'pending' };

export class WedgeDetector {
  private buffer = '';
  private lastAt = 0;
  private readonly maxGapMs: number;
  private readonly minLength: number;
  private readonly terminators: readonly string[];

  constructor(options: WedgeOptions = {}) {
    this.maxGapMs = options.maxGapMs ?? 50;
    this.minLength = options.minLength ?? 4;
    this.terminators = options.terminators ?? ['Enter', 'Tab'];
  }

  /** Feed one key (`KeyboardEvent.key`) with its timestamp in ms. */
  feed(key: string, at: number): WedgeResult {
    let flushed: WedgeResult | null = null;
    if (this.buffer.length > 0 && at - this.lastAt > this.maxGapMs) {
      flushed = { kind: 'typed', text: this.buffer, terminator: null };
      this.buffer = '';
    }
    this.lastAt = at;
    if (this.terminators.includes(key)) {
      const code = this.buffer;
      this.buffer = '';
      if (code.length >= this.minLength) return { kind: 'scan', code };
      return { kind: 'typed', text: code, terminator: key };
    }
    if (key.length === 1) {
      this.buffer += key;
      return flushed ?? { kind: 'pending' };
    }
    return flushed ?? { kind: 'pending' };
  }

  reset(): void {
    this.buffer = '';
  }
}

export class HidWedgeScanner implements Scanner {
  private readonly listeners = new Set<ScanListener>();
  private readonly detector: WedgeDetector;

  constructor(
    public readonly profile: DeviceProfile = {
      id: 'hid-wedge',
      name: 'USB HID scanner (keyboard wedge)',
      kind: 'scanner',
      transport: 'usb',
      capabilities: ['barcode_scan'],
    },
    options: WedgeOptions = {},
  ) {
    this.detector = new WedgeDetector(options);
  }

  /** Called by the host for every key event; returns what the host should do with the key. */
  handleKey(key: string, at: number): WedgeResult {
    const result = this.detector.feed(key, at);
    if (result.kind === 'scan') {
      const event: ScanEvent = { code: result.code, at, source: this.profile.id };
      for (const listener of this.listeners) listener(event);
    }
    return result;
  }

  onScan(listener: ScanListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async status(): Promise<PeripheralStatus> {
    // A wedge scanner is indistinguishable from the keyboard; "ready" means listening.
    return { online: true, state: 'ready', detail: 'Listening for keyboard-wedge input' };
  }
}
