/**
 * Network ESC/POS receipt printer driver (TCP 9100, "raw" / JetDirect-style port).
 *
 * One connection per job: most receipt printers accept a single client at a time, and a long-lived
 * socket would block a second register or the kitchen service from printing.
 */
import { ESCPOS, decodeStatus, encodeDocument, type EscPosOptions } from './escpos.js';
import type {
  ByteTransport,
  DeviceProfile,
  PeripheralStatus,
  PrintDocument,
  PrintResult,
  ReceiptPrinter,
} from './types.js';

export type TransportFactory = (profile: DeviceProfile) => ByteTransport;

export interface EscPosPrinterOptions extends EscPosOptions {
  /** How long to wait for the real-time status reply, per query. */
  readonly statusTimeoutMs?: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class EscPosPrinter implements ReceiptPrinter {
  constructor(
    public readonly profile: DeviceProfile,
    private readonly makeTransport: TransportFactory,
    private readonly options: EscPosPrinterOptions = {},
  ) {}

  private get escOptions(): EscPosOptions {
    const columns = this.options.columns ?? (this.profile.options?.columns as number | undefined);
    return { ...this.options, ...(columns !== undefined ? { columns } : {}) };
  }

  async print(document: PrintDocument): Promise<PrintResult> {
    return this.send(encodeDocument(document, this.escOptions));
  }

  async kickDrawer(): Promise<PrintResult> {
    return this.send(Uint8Array.from([...ESCPOS.init, ...ESCPOS.drawerKick]));
  }

  async status(): Promise<PeripheralStatus> {
    const transport = this.makeTransport(this.profile);
    try {
      await transport.open();
    } catch (error) {
      return { online: false, state: 'offline', detail: message(error) };
    }
    try {
      const timeout = this.options.statusTimeoutMs ?? 500;
      await transport.write(
        Uint8Array.from([...ESCPOS.statusPrinter, ...ESCPOS.statusOffline, ...ESCPOS.statusPaper]),
      );
      const reply = await transport.read(3, timeout);
      if (reply.length < 3) {
        // Connected but silent: some clones do not answer DLE EOT. Reachable is still useful.
        return { online: true, state: 'unknown', detail: 'Connected; no status reply' };
      }
      const s = decodeStatus(reply[0], reply[1], reply[2]);
      const problems = [
        s.offline && 'printer offline',
        s.coverOpen && 'cover open',
        s.paperOut && 'paper out',
      ].filter(Boolean) as string[];
      return {
        online: !s.offline && !s.coverOpen && !s.paperOut,
        state: problems.length > 0 ? 'degraded' : s.paperLow ? 'degraded' : 'ready',
        ...(problems.length > 0
          ? { detail: problems.join(', ') }
          : s.paperLow
            ? { detail: 'paper low' }
            : {}),
        paperOut: s.paperOut,
        paperLow: s.paperLow,
        coverOpen: s.coverOpen,
        ...(s.drawerOpen !== undefined ? { drawerOpen: s.drawerOpen } : {}),
      };
    } catch (error) {
      return { online: false, state: 'offline', detail: message(error) };
    } finally {
      await transport.close().catch(() => undefined);
    }
  }

  private async send(bytes: Uint8Array): Promise<PrintResult> {
    const transport = this.makeTransport(this.profile);
    try {
      await transport.open();
    } catch (error) {
      // Nothing reached the printer, so a retry cannot double-print.
      return { ok: false, retryable: true, error: `Printer unreachable: ${message(error)}` };
    }
    try {
      await transport.write(bytes);
      return { ok: true };
    } catch (error) {
      // The job may be partly printed; do not mark it safe to retry automatically.
      return { ok: false, retryable: false, error: `Print failed: ${message(error)}` };
    } finally {
      await transport.close().catch(() => undefined);
    }
  }
}
