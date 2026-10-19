import type { ApiClient } from '../api/client.js';
import type { SessionManager } from '../session/session-manager.js';
import type { ReplicaStore } from '../store/stores.js';

/**
 * Names of staff who have signed in on this register. A device token cannot list users, so the name is
 * learned from `GET /v1/users/me` right after a successful PIN login and kept in the replica store, which
 * is also what the PIN screen offers as buttons next time.
 */
export class StaffDirectory {
  private names = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(
    private readonly replicas: ReplicaStore,
    private readonly session: SessionManager,
    private readonly clientFor: (baseUrl: string) => ApiClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  getVersion = () => this.version;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  nameOf(userId: string): string | null {
    return this.names.get(userId) ?? null;
  }

  private bump() {
    this.version += 1;
    for (const l of this.listeners) l();
  }

  async load(): Promise<void> {
    this.names = new Map((await this.replicas.staff()).map((s) => [s.userId, s.displayName]));
    this.bump();
  }

  /** Start watching the session: learn the name of whoever signs in. Returns the unsubscribe function. */
  watch(): () => void {
    void this.load().then(() => this.learnCurrent());
    return this.session.subscribe(() => void this.learnCurrent());
  }

  private learning: string | null = null;

  private async learnCurrent(): Promise<void> {
    const state = this.session.getState();
    if (state.phase !== 'signed_in') return;
    const userId = state.staff.userId;
    if (this.names.has(userId) || this.learning === userId) return;
    this.learning = userId;
    let displayName = `Staff ${userId.slice(0, 6)}`;
    try {
      const token = await this.session.accessToken();
      if (token)
        displayName = (await this.clientFor(state.identity.apiBaseUrl).userMe(token)).displayName;
    } catch {
      // Offline or not permitted: fall back to a short id; the real name is learned at the next sign-in.
    }
    await this.replicas.rememberStaff({ userId, displayName }, this.now().toISOString());
    this.names.set(userId, displayName);
    this.learning = null;
    this.bump();
  }
}
