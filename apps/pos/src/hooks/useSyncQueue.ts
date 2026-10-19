import { useEffect, useState } from 'react';
import type { CommandLog } from '@pos/sync-protocol';

export interface SyncQueueState {
  /** Commands recorded locally and not yet confirmed by the server (pending + in flight). */
  readonly unsynced: number;
  /** Commands the server rejected: they need a manager. */
  readonly rejected: number;
}

/** Live counts for the unsynced-command badge (docs/04 §3.2 SyncQueueBadge). */
export function useSyncQueue(log: CommandLog): SyncQueueState {
  const [state, setState] = useState<SyncQueueState>({ unsynced: 0, rejected: 0 });
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const [unsynced, rejected] = await Promise.all([
        log.pendingCount(),
        log.rejected().then((r) => r.length),
      ]);
      if (!cancelled)
        setState((prev) =>
          prev.unsynced === unsynced && prev.rejected === rejected ? prev : { unsynced, rejected },
        );
    };
    void refresh();
    const off = log.subscribe(() => void refresh());
    return () => {
      cancelled = true;
      off();
    };
  }, [log]);
  return state;
}
