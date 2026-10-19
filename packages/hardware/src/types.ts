/**
 * Peripheral abstractions (docs/03-implementation-plan.md §1, Hardware row). Every driver, real or
 * mock, implements one of the interfaces below so the POS never depends on a concrete device.
 */

export type PeripheralKind =
  | 'receipt_printer'
  | 'kitchen_printer'
  | 'label_printer'
  | 'cash_drawer'
  | 'scanner'
  | 'scale'
  | 'customer_display';

export type Transport = 'usb' | 'serial' | 'bluetooth' | 'network' | 'builtin';

export type PeripheralCapability =
  | 'print_escpos'
  | 'print_starline'
  | 'print_zpl'
  | 'drawer_kick'
  | 'cutter'
  | 'barcode_scan'
  | 'weigh_ntep'
  | 'weigh_oiml'
  | 'display_text';

export interface DeviceProfile {
  readonly id: string;
  readonly name: string;
  readonly kind: PeripheralKind;
  readonly transport: Transport;
  readonly capabilities: readonly PeripheralCapability[];
  /** Transport address: "host:port" (network), "vid:pid" (usb), serial path or bluetooth address. */
  readonly address?: string;
  /** Free-form driver options (paper width in characters, baud rate, drawer pin...). */
  readonly options?: Readonly<Record<string, string | number | boolean>>;
}

/** Health of one peripheral, as shown on the diagnostics screen. */
export type PeripheralState = 'ready' | 'degraded' | 'offline' | 'unknown';

export interface PeripheralStatus {
  readonly online: boolean;
  readonly state?: PeripheralState;
  readonly detail?: string;
  /** Printer-specific flags decoded from the real-time status bytes. */
  readonly paperOut?: boolean;
  readonly paperLow?: boolean;
  readonly coverOpen?: boolean;
  readonly drawerOpen?: boolean;
}

export interface Peripheral {
  readonly profile: DeviceProfile;
  status(): Promise<PeripheralStatus>;
  /** Release the transport. Safe to call twice. */
  close?(): Promise<void>;
}

// --- printing -------------------------------------------------------------------------------

export type TextAlign = 'left' | 'center' | 'right';

/** A structured receipt line, so drivers can render text or raster without parsing strings. */
export type PrintLine =
  | string
  | {
      readonly text: string;
      readonly align?: TextAlign;
      readonly bold?: boolean;
      readonly doubleHeight?: boolean;
      readonly doubleWidth?: boolean;
      readonly underline?: boolean;
    }
  | { readonly barcode: string; readonly kind?: 'code128' | 'ean13' | 'upca' }
  | { readonly qr: string }
  | { readonly rule: true };

export interface PrintDocument {
  readonly lines: readonly PrintLine[];
  readonly cut?: boolean;
  /** Kick the drawer at the end of the job (cash tender). */
  readonly openDrawer?: boolean;
}

export interface PrintResult {
  readonly ok: boolean;
  readonly error?: string;
  /** Set when the job could not be delivered but is safe to retry (printer offline). */
  readonly retryable?: boolean;
}

export interface ReceiptPrinter extends Peripheral {
  print(document: PrintDocument): Promise<PrintResult>;
  /** Pulse the cash drawer attached to the printer's DK port. */
  kickDrawer?(): Promise<PrintResult>;
}

export interface CashDrawer extends Peripheral {
  open(): Promise<PrintResult>;
}

// --- scanner --------------------------------------------------------------------------------

export interface ScanEvent {
  readonly code: string;
  readonly symbology?: string;
  /** Wall-clock milliseconds when the last character arrived. */
  readonly at: number;
  readonly source: string;
}

export type ScanListener = (event: ScanEvent) => void;

export interface Scanner extends Peripheral {
  /** Subscribe to scans; returns an unsubscribe function. */
  onScan(listener: ScanListener): () => void;
}

// --- scale ----------------------------------------------------------------------------------

export interface ScaleReading {
  readonly weight: string; // decimal string, e.g. "1.2550"
  readonly unit: 'kg' | 'lb';
  readonly stable: boolean;
}

export interface Scale extends Peripheral {
  read(): Promise<ScaleReading>;
}

// --- customer display -----------------------------------------------------------------------

export interface CustomerDisplayFrame {
  readonly lines: readonly string[];
  readonly total?: string;
}

export interface CustomerDisplay extends Peripheral {
  show(frame: CustomerDisplayFrame): Promise<void>;
  clear(): Promise<void>;
}

/** Byte pipe used by wire-level drivers. TCP, USB and serial adapters implement it. */
export interface ByteTransport {
  /** Open (or re-open) the pipe. Rejects when the device is unreachable. */
  open(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  /**
   * Read up to `length` bytes, resolving with fewer (possibly none) after `timeoutMs`. Used for the
   * printer's real-time status reply.
   */
  read(length: number, timeoutMs: number): Promise<Uint8Array>;
  close(): Promise<void>;
}
