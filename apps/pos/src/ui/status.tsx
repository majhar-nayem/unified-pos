import type { ConnectivityState } from '../hooks/connectivity.js';
import type { SyncQueueState } from '../hooks/useSyncQueue.js';

/** Never colour alone: a glyph and a word carry the state (docs/04 §3.1 contrast rule). */
export function ConnectivityIndicator({ state }: { state: ConnectivityState }) {
  const label =
    state.status === 'online' ? 'Online' : state.status === 'offline' ? 'Offline' : 'Checking…';
  const glyph = state.status === 'online' ? '●' : state.status === 'offline' ? '○' : '◌';
  return (
    <span
      className={`pill pill--${state.status}`}
      role="status"
      aria-label={`Connection: ${label}`}
    >
      <span aria-hidden="true">{glyph}</span> {label}
    </span>
  );
}

export function SyncBadge({ queue }: { queue: SyncQueueState }) {
  const text =
    queue.rejected > 0
      ? `Unsynced: ${queue.unsynced} · ${queue.rejected} rejected`
      : `Unsynced: ${queue.unsynced}`;
  return (
    <span
      className={`pill ${queue.rejected > 0 ? 'pill--alert' : ''}`}
      role="status"
      aria-label={text}
    >
      {queue.rejected > 0 ? <span aria-hidden="true">⚠ </span> : null}
      {text}
    </span>
  );
}
