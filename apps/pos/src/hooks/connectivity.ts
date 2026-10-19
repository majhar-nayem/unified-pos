import { useSyncExternalStore } from 'react';

export type ConnectivityStatus = 'online' | 'offline' | 'unknown';

export interface ConnectivityState {
  readonly status: ConnectivityStatus;
  /** Epoch ms when the status last changed. */
  readonly since: number;
  readonly lastCheckedAt: number | null;
}

export interface ConnectivityOptions {
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly setInterval?: (fn: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
  /** Browser online/offline event source; defaults to `window`. */
  readonly events?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
}

/**
 * Online/offline tracking: the browser's `online`/`offline` events give instant hints, and an active
 * probe (`GET /v1/health`) is the truth, because a LAN without internet reports `navigator.onLine`.
 * API callers can also feed results in with `report()`.
 */
export class ConnectivityMonitor {
  private state: ConnectivityState;
  private readonly listeners = new Set<() => void>();
  private handle: unknown = null;
  private readonly now: () => number;
  private readonly onOnline = () => void this.check();
  private readonly onOffline = () => this.report(false);

  constructor(
    private readonly probe: () => Promise<boolean>,
    private readonly options: ConnectivityOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.state = { status: 'unknown', since: this.now(), lastCheckedAt: null };
  }

  getState = (): ConnectivityState => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    if (this.handle !== null) return;
    const events =
      this.options.events === undefined
        ? typeof window === 'undefined'
          ? null
          : window
        : this.options.events;
    events?.addEventListener('online', this.onOnline);
    events?.addEventListener('offline', this.onOffline);
    const set = this.options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.handle = set(() => void this.check(), this.options.intervalMs ?? 15_000);
    void this.check();
  }

  stop(): void {
    if (this.handle === null) return;
    const clear =
      this.options.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    clear(this.handle);
    this.handle = null;
    const events =
      this.options.events === undefined
        ? typeof window === 'undefined'
          ? null
          : window
        : this.options.events;
    events?.removeEventListener('online', this.onOnline);
    events?.removeEventListener('offline', this.onOffline);
  }

  async check(): Promise<ConnectivityStatus> {
    let ok = false;
    try {
      ok = await this.probe();
    } catch {
      ok = false;
    }
    this.report(ok);
    return this.state.status;
  }

  /** Record a result observed elsewhere (a successful sync, a network error). */
  report(online: boolean): void {
    const status: ConnectivityStatus = online ? 'online' : 'offline';
    const t = this.now();
    this.state = {
      status,
      since: status === this.state.status ? this.state.since : t,
      lastCheckedAt: t,
    };
    for (const l of this.listeners) l();
  }
}

export function useConnectivity(monitor: ConnectivityMonitor): ConnectivityState {
  return useSyncExternalStore(monitor.subscribe, monitor.getState, monitor.getState);
}
