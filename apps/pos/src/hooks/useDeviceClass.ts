import { useEffect, useState } from 'react';

/** Device classes of docs/04-design-plan.md §2 as far as the POS app is concerned. */
export type DeviceClass = 'terminal' | 'tablet-landscape' | 'tablet-portrait' | 'handheld';

/** Breakpoints (CSS tokens `--bp-handheld/tablet/terminal`). */
export const BREAKPOINTS = { tablet: 800, terminal: 1366 } as const;

export function classifyViewport(width: number, height: number): DeviceClass {
  if (width >= BREAKPOINTS.terminal) return 'terminal';
  if (width >= BREAKPOINTS.tablet) return height > width ? 'tablet-portrait' : 'tablet-landscape';
  return 'handheld';
}

export function useDeviceClass(): DeviceClass {
  const read = () => classifyViewport(window.innerWidth, window.innerHeight);
  const [value, setValue] = useState<DeviceClass>(read);
  useEffect(() => {
    const onResize = () => setValue(read());
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);
  return value;
}
