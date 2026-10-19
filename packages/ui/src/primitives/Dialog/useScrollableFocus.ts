import { useEffect, useState } from 'react';

/**
 * A scrollable region must be keyboard focusable (WCAG 2.1.1, axe `scrollable-region-focusable`). Returns a
 * callback ref for the scroll container and whether it currently overflows, so the container gets
 * `tabIndex=0` only when it actually scrolls (otherwise it would be a pointless tab stop).
 */
export function useScrollableFocus() {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [scrollable, setScrollable] = useState(false);

  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setScrollable(element.scrollHeight > element.clientHeight + 1);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return { attach: setElement, tabIndex: scrollable ? (0 as const) : undefined };
}
