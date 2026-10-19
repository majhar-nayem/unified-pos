import { useEffect } from 'react';

let locks = 0;
let saved: { overflow: string; paddingRight: string } | null = null;

/** Locks page scroll while any overlay is open (reference counted so stacked overlays restore correctly). */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    const body = document.body;
    if (locks === 0) {
      saved = { overflow: body.style.overflow, paddingRight: body.style.paddingRight };
      const viewport = document.documentElement.clientWidth;
      const scrollbar = viewport > 0 ? window.innerWidth - viewport : 0;
      body.style.overflow = 'hidden';
      // Keeps the layout from shifting when the scrollbar disappears.
      if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;
    }
    locks += 1;
    return () => {
      locks -= 1;
      if (locks === 0 && saved) {
        body.style.overflow = saved.overflow;
        body.style.paddingRight = saved.paddingRight;
        saved = null;
      }
    };
  }, [active]);
}
