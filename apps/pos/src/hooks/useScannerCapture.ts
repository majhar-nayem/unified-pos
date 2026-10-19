import { useEffect, useRef } from 'react';
import { HidWedgeScanner, type ScanEvent, type Scanner } from '@pos/hardware';

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['button', 'checkbox', 'radio', 'submit', 'reset'].includes(type);
  }
  return tag === 'SELECT';
}

export interface ScannerCaptureOptions {
  readonly enabled?: boolean;
  /** Extra scanners (native/Bluetooth/mock) whose scans are delivered through the same handler. */
  readonly scanners?: readonly Scanner[];
  readonly maxGapMs?: number;
  readonly minLength?: number;
}

/**
 * Global scanner capture (docs/04-design-plan.md §4.1: "scanner input is captured globally, no focus
 * needed"). Keyboard-wedge scanners type the code fast and end with Enter; the detector tells that
 * apart from a person typing by inter-key timing.
 *
 * Rules:
 *  - Keys typed while a text field has focus are left alone (the field is the user's target), unless
 *    the field opts in with `data-scan-target`.
 *  - Otherwise characters of an in-progress scan are swallowed so a scanner never triggers shortcuts,
 *    and the terminating Enter is swallowed so it cannot click the focused button.
 */
export function useScannerCapture(
  onScan: (event: ScanEvent) => void,
  options: ScannerCaptureOptions = {},
): void {
  const handler = useRef(onScan);
  handler.current = onScan;
  const { enabled = true, scanners, maxGapMs, minLength } = options;

  useEffect(() => {
    if (!enabled) return undefined;
    const wedge = new HidWedgeScanner(undefined, {
      ...(maxGapMs !== undefined ? { maxGapMs } : {}),
      ...(minLength !== undefined ? { minLength } : {}),
    });
    const offs = [wedge, ...(scanners ?? [])].map((s) => s.onScan((e) => handler.current(e)));

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      const editable =
        isEditable(target) && !(target as HTMLElement).hasAttribute('data-scan-target');
      if (editable) return;
      const result = wedge.handleKey(event.key, event.timeStamp || performance.now());
      if (result.kind === 'scan') event.preventDefault();
      else if (event.key.length === 1 || result.kind === 'pending') {
        if (event.key.length === 1) event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      offs.forEach((off) => off());
    };
  }, [enabled, scanners, maxGapMs, minLength]);
}
