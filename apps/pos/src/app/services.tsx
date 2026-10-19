import { createContext, useContext, type ReactNode } from 'react';
import { CommandLog, HybridLogicalClock } from '@pos/sync-protocol';
import type { PeripheralManager } from '@pos/hardware';

import { ApiClient, type FetchLike } from '../api/client.js';
import { CartService } from '../cart/cart.js';
import { ScanService } from '../cart/scan.js';
import { openCfdChannel, type CfdTransport } from '../cfd/channel.js';
import { createHardware, type HardwareSetup } from '../hardware/setup.js';
import { ConnectivityMonitor } from '../hooks/connectivity.js';
import { createDeviceKeys, createSecretStore } from '../platform/keys.js';
import {
  LocalStorageKeyValueStore,
  type DeviceKeys,
  type KeyValueStore,
  type SecretStore,
} from '../platform/ports.js';
import { isTauri } from '../platform/runtime.js';
import { SessionManager } from '../session/session-manager.js';
import { createMemoryStore, type LocalStore } from '../store/stores.js';
import { openTauriStore } from '../store/tauri-sql.js';
import { StaffDirectory } from './staff.js';
import { SyncCoordinator } from './sync.js';

export interface Services {
  readonly session: SessionManager;
  readonly store: LocalStore;
  readonly log: CommandLog;
  readonly cart: CartService;
  readonly scan: ScanService;
  readonly hardware: HardwareSetup;
  readonly connectivity: ConnectivityMonitor;
  readonly sync: SyncCoordinator;
  readonly staff: StaffDirectory;
  readonly cfd: CfdTransport | null;
  readonly settings: KeyValueStore;
  readonly keys: DeviceKeys;
  readonly secrets: SecretStore;
  readonly clientFor: (baseUrl: string) => ApiClient;
  readonly appVersion: string;
  /** ISO 4217 code used to format placeholder prices until the location currency is known. */
  readonly currency: string;
}

export interface ServiceOverrides {
  readonly store?: LocalStore;
  readonly keys?: DeviceKeys;
  readonly secrets?: SecretStore;
  readonly settings?: KeyValueStore;
  readonly fetch?: FetchLike;
  readonly hardware?: HardwareSetup;
  readonly cfd?: CfdTransport | null;
  readonly now?: () => number;
}

export const APP_VERSION = '0.0.0';

/** Wire everything. Real adapters in Tauri, simulated ones in the browser dev build and in tests. */
export async function createServices(overrides: ServiceOverrides = {}): Promise<Services> {
  const settings = overrides.settings ?? new LocalStorageKeyValueStore();
  const keys = overrides.keys ?? createDeviceKeys();
  const secrets = overrides.secrets ?? createSecretStore();
  const store = overrides.store ?? (isTauri() ? await openTauriStore() : createMemoryStore());
  const hardware = overrides.hardware ?? createHardware(settings);
  const clientFor = (baseUrl: string) => new ApiClient(baseUrl, overrides.fetch);

  const session = new SessionManager({
    keys,
    secrets,
    kv: settings,
    makeClient: clientFor,
    ...(overrides.now ? { now: overrides.now } : {}),
    platform: isTauri() ? detectPlatform() : 'web',
    appVersion: APP_VERSION,
  });
  await session.init();

  // The HLC node id is the device id once enrolled; before that, a placeholder that never reaches the server.
  const state = session.getState();
  const node =
    state.phase === 'signed_in' || state.phase === 'signed_out'
      ? state.identity.deviceId
      : 'unenrolled';
  const log = new CommandLog(store.commands, new HybridLogicalClock(node));
  await log.init();

  const cart = new CartService(log, store.projections);
  await cart.recover();
  const scan = new ScanService(store.replicas, cart, hardware.manager as PeripheralManager);

  const connectivity = new ConnectivityMonitor(async () => {
    const s = session.getState();
    if (s.phase === 'unenrolled' || s.phase === 'loading')
      return typeof navigator === 'undefined' ? true : navigator.onLine;
    return clientFor(s.identity.apiBaseUrl).health();
  });
  const sync = new SyncCoordinator(session, store, log, clientFor, connectivity);
  const staff = new StaffDirectory(store.replicas, session, clientFor);
  staff.watch();

  return {
    session,
    store,
    log,
    cart,
    scan,
    hardware,
    connectivity,
    sync,
    staff,
    cfd:
      overrides.cfd === undefined
        ? typeof BroadcastChannel === 'undefined'
          ? null
          : openCfdChannel()
        : overrides.cfd,
    settings,
    keys,
    secrets,
    clientFor,
    appVersion: APP_VERSION,
    currency: settings.get('currency') ?? 'AUD',
  };
}

function detectPlatform(): 'windows' | 'android' | 'ios' | 'macos' | 'linux' {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('android')) return 'android';
  if (ua.includes('iphone') || ua.includes('ipad')) return 'ios';
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('win')) return 'windows';
  return 'linux';
}

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({
  services,
  children,
}: {
  services: Services;
  children: ReactNode;
}) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const value = useContext(ServicesContext);
  if (!value) throw new Error('useServices() outside ServicesProvider');
  return value;
}
