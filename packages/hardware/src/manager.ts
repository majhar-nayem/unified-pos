/** Registry of the peripherals attached to this register, with a diagnostics snapshot. */
import type { Peripheral, PeripheralKind, PeripheralState, PeripheralStatus } from './types.js';

export interface DiagnosticsRow {
  readonly id: string;
  readonly name: string;
  readonly kind: PeripheralKind;
  readonly transport: string;
  readonly address: string | null;
  readonly state: PeripheralState;
  readonly online: boolean;
  readonly detail: string | null;
  /** ms taken by the status call: a slow printer shows up here before it fails. */
  readonly latencyMs: number;
  readonly checkedAt: string;
}

export class PeripheralManager {
  private readonly peripherals = new Map<string, Peripheral>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  register(peripheral: Peripheral): void {
    this.peripherals.set(peripheral.profile.id, peripheral);
  }

  async unregister(id: string): Promise<void> {
    const p = this.peripherals.get(id);
    this.peripherals.delete(id);
    await p?.close?.();
  }

  get<T extends Peripheral>(id: string): T | undefined {
    return this.peripherals.get(id) as T | undefined;
  }

  ofKind<T extends Peripheral>(kind: PeripheralKind): T[] {
    return [...this.peripherals.values()].filter((p) => p.profile.kind === kind) as T[];
  }

  /** First peripheral of a kind, e.g. the receipt printer for a sale. */
  first<T extends Peripheral>(kind: PeripheralKind): T | undefined {
    return this.ofKind<T>(kind)[0];
  }

  async diagnostics(timeoutMs = 3000): Promise<DiagnosticsRow[]> {
    return Promise.all(
      [...this.peripherals.values()].map(async (p) => {
        const started = this.now();
        let status: PeripheralStatus;
        try {
          status = await Promise.race([
            p.status(),
            new Promise<PeripheralStatus>((resolve) =>
              setTimeout(
                () =>
                  resolve({ online: false, state: 'offline', detail: 'Status check timed out' }),
                timeoutMs,
              ),
            ),
          ]);
        } catch (error) {
          status = {
            online: false,
            state: 'offline',
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        const checkedAt = this.now();
        return {
          id: p.profile.id,
          name: p.profile.name,
          kind: p.profile.kind,
          transport: p.profile.transport,
          address: p.profile.address ?? null,
          state: status.state ?? (status.online ? 'ready' : 'offline'),
          online: status.online,
          detail: status.detail ?? null,
          latencyMs: checkedAt - started,
          checkedAt: new Date(checkedAt).toISOString(),
        };
      }),
    );
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.peripherals.values()].map((p) => p.close?.()));
    this.peripherals.clear();
  }
}
