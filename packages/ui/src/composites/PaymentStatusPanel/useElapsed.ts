import { useEffect, useState } from 'react';

/**
 * Whole seconds elapsed since `startedAt` (epoch ms or Date), re-evaluated once a second. Optional helper
 * for apps feeding `PaymentStatusPanel.elapsedSeconds`; the panel itself has no timers, so tests and stories
 * stay deterministic by passing the number directly. Returns 0 when `startedAt` is undefined.
 */
export function useElapsed(startedAt: number | Date | undefined, intervalMs = 1000): number {
  const start = startedAt instanceof Date ? startedAt.getTime() : startedAt;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (start === undefined) return undefined;
    const id = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [start, intervalMs]);

  return start === undefined ? 0 : Math.max(0, Math.floor((now - start) / 1000));
}
