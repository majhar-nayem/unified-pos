/**
 * Sync coordinator: replica pull + command upload, driven by connectivity and a timer.
 *
 * Upload endpoint status: `POST /v1/sync/batches` is part of M1 (Wave 2) and does not exist in F1.
 * Until it does the server answers 404, the batch goes back to pending, and the unsynced badge keeps
 * counting: that is the honest state, not an error to hide.
 */
import { SyncUploader, type CommandLog, type SyncBatchResult } from '@pos/sync-protocol';

import { ApiError, type ApiClient } from '../api/client.js';
import { ReplicaLoader, type ReplicaSyncResult } from '../store/replica-loader.js';
import type { LocalStore } from '../store/stores.js';
import type { ConnectivityMonitor } from '../hooks/connectivity.js';
import type { SessionManager } from '../session/session-manager.js';

export interface SyncStatus {
  readonly running: boolean;
  readonly replica: ReplicaSyncResult | null;
  readonly lastSyncAt: number | null;
  readonly uploadError: string | null;
}

export class SyncCoordinator {
  private status: SyncStatus = {
    running: false,
    replica: null,
    lastSyncAt: null,
    uploadError: null,
  };
  private readonly listeners = new Set<() => void>();
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly session: SessionManager,
    private readonly store: LocalStore,
    private readonly log: CommandLog,
    private readonly clientFor: (baseUrl: string) => ApiClient,
    private readonly connectivity: ConnectivityMonitor,
    private readonly now: () => number = () => Date.now(),
  ) {}

  getStatus = (): SyncStatus => this.status;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  private set(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l();
  }

  syncNow(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.run().finally(() => {
        this.inFlight = null;
        this.set({ running: false });
      });
    }
    return this.inFlight;
  }

  private async run(): Promise<void> {
    const state = this.session.getState();
    if (state.phase !== 'signed_in') return;
    this.set({ running: true });
    const client = this.clientFor(state.identity.apiBaseUrl);
    const token = await this.session.accessToken();
    if (!token) {
      // Expired and unreachable: keep working locally.
      this.connectivity.report(false);
      return;
    }
    const replica = await new ReplicaLoader(this.store, client).sync(token);
    if (replica.source !== 'offline') this.connectivity.report(true);
    else this.connectivity.report(false);
    this.set({ replica });

    let uploadError: string | null = null;
    const uploader = new SyncUploader(this.log, state.identity.deviceId, async (batch) => {
      const raw = await client.request('POST', '/sync/batches', { token, body: batch });
      return raw as SyncBatchResult;
    });
    try {
      await uploader.drain();
    } catch (error) {
      uploadError =
        error instanceof ApiError && error.status === 404
          ? 'The server has no sync endpoint yet; commands stay on this register.'
          : error instanceof Error
            ? error.message
            : 'Upload failed';
    }
    this.set({ lastSyncAt: this.now(), uploadError });
  }
}
