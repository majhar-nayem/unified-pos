/**
 * Tells a hardware barcode scanner from a person typing. A scanner emits its characters a few milliseconds
 * apart and then a terminator key (normally Enter); a person never types four characters 50 ms apart and
 * presses Enter within that gap. The detector is pure (time is passed in) so it is unit-testable.
 */
export interface ScanOptions {
  /** Minimum characters for a burst to count as a scan. */
  readonly minLength: number;
  /** Largest gap between consecutive keys, in ms, for them to belong to the same burst. */
  readonly maxKeyGapMs: number;
  /** `KeyboardEvent.key` that ends a scan. */
  readonly terminator: string;
}

export type ScanKeyResult =
  | { readonly kind: 'char'; readonly length: number }
  | { readonly kind: 'scan'; readonly code: string }
  | { readonly kind: 'ignored' };

export interface ScanKeyEvent {
  readonly key: string;
  readonly repeat?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly isComposing?: boolean;
}

const MODIFIER_KEYS = new Set(['Shift', 'CapsLock', 'AltGraph', 'Alt', 'Control', 'Meta']);

export interface ScanDetector {
  /** Characters currently buffered in the burst. */
  readonly length: number;
  reset(): void;
  handleKey(event: ScanKeyEvent, options: ScanOptions, now?: number): ScanKeyResult;
}

export function createScanDetector(): ScanDetector {
  let buffer = '';
  let last = 0;
  const reset = () => {
    buffer = '';
  };
  return {
    get length() {
      return buffer.length;
    },
    reset,
    handleKey(event, options, now = Date.now()) {
      // Scanners that send capitals emit Shift key presses between characters; they are not part of the code.
      if (MODIFIER_KEYS.has(event.key)) return { kind: 'ignored' };
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) {
        reset();
        return { kind: 'ignored' };
      }
      if (event.key === options.terminator) {
        const fast = buffer.length > 0 && now - last <= options.maxKeyGapMs;
        const code = buffer;
        reset();
        return fast && code.length >= options.minLength
          ? { kind: 'scan', code }
          : { kind: 'ignored' };
      }
      if ([...event.key].length === 1) {
        if (event.repeat) {
          reset();
          return { kind: 'ignored' };
        }
        const continuing = buffer.length > 0 && now - last <= options.maxKeyGapMs;
        buffer = continuing ? buffer + event.key : event.key;
        last = now;
        return { kind: 'char', length: buffer.length };
      }
      reset();
      return { kind: 'ignored' };
    },
  };
}
