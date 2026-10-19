import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { cx } from '../../foundation/cx.js';
import { Icon } from '../../foundation/Icon.js';
import { useUi } from '../../foundation/UiProvider.js';
import { mergeRefs } from '../Field/internal.js';
import { Input, type InputProps } from '../Input/Input.js';

import { createScanDetector, type ScanOptions } from './scanDetector.js';

export interface SearchProps extends Omit<
  InputProps,
  'type' | 'prefix' | 'suffix' | 'value' | 'defaultValue' | 'label' | 'onSubmit' | 'children'
> {
  /** Accessible name. Defaults to "Search" and is visually hidden unless `hideLabel={false}`. */
  readonly label?: ReactNode;
  readonly value?: string;
  readonly defaultValue?: string;
  /** Fires on every typed change (and when the field is cleared or restored after a scan). */
  readonly onQueryChange?: (query: string) => void;
  /** Fires when a person presses Enter (a typed search, not a scan). */
  readonly onSubmit?: (query: string) => void;
  /** Fires with the barcode when a scanner burst ends with the terminator key. */
  readonly onScan?: (code: string) => void;
  /** Minimum characters for a burst to be a scan. Default 4. */
  readonly minLength?: number;
  /** Max gap between scanner keystrokes in ms. Default 50. */
  readonly maxKeyGapMs?: number;
  /** `KeyboardEvent.key` that ends a scan. Default `Enter`. */
  readonly scanTerminator?: string;
  /** Leave the scanned code in the field. By default the field returns to what it held before the scan. */
  readonly keepValueOnScan?: boolean;
  /** Also capture scans while no editable element has focus (anywhere on the page). */
  readonly captureGlobally?: boolean;
  readonly onClear?: () => void;
}

const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'range',
  'file',
  'image',
  'color',
]);

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(target.type);
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target.closest('[contenteditable=""], [contenteditable="true"]') !== null;
}

/**
 * Search field with barcode scanner capture. Scans (fast burst + terminator) call `onScan` and do not
 * stay in the field; human typing calls `onQueryChange` and Enter calls `onSubmit`.
 */
export function Search({
  label,
  hideLabel = true,
  value: valueProp,
  defaultValue = '',
  onQueryChange,
  onSubmit,
  onScan,
  minLength = 4,
  maxKeyGapMs = 50,
  scanTerminator = 'Enter',
  keepValueOnScan = false,
  captureGlobally = false,
  onClear,
  className,
  disabled,
  readOnly,
  onChange,
  onKeyDown,
  onBlur,
  ref,
  ...rest
}: SearchProps) {
  const { t } = useUi();
  const [inner, setInner] = useState(defaultValue);
  const value = valueProp ?? inner;
  const inputRef = useRef<HTMLInputElement>(null);
  const merged = useMemo(() => mergeRefs(inputRef, ref), [ref]);
  const detector = useMemo(() => createScanDetector(), []);
  const valueBeforeBurst = useRef('');
  const onScanRef = useRef(onScan);
  useEffect(() => {
    onScanRef.current = onScan;
  });

  const setQuery = (next: string) => {
    setInner(next);
    onQueryChange?.(next);
  };
  const options: ScanOptions = { minLength, maxKeyGapMs, terminator: scanTerminator };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange?.(event);
    setQuery(event.target.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const result = detector.handleKey(event.nativeEvent, options);
    if (result.kind === 'char' && result.length === 1) {
      valueBeforeBurst.current = event.currentTarget.value;
    }
    if (result.kind === 'scan') {
      event.preventDefault();
      if (!keepValueOnScan) setQuery(valueBeforeBurst.current);
      onScanRef.current?.(result.code);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      onSubmit?.(event.currentTarget.value);
    } else if (event.key === 'Escape' && event.currentTarget.value !== '') {
      event.preventDefault();
      event.stopPropagation();
      clear();
    }
  };

  const clear = () => {
    setQuery('');
    onClear?.();
    inputRef.current?.focus();
  };

  useEffect(() => {
    if (!captureGlobally) return;
    const globalDetector = createScanDetector();
    const opts: ScanOptions = { minLength, maxKeyGapMs, terminator: scanTerminator };
    const listener = (event: globalThis.KeyboardEvent) => {
      if (event.target === inputRef.current) return;
      if (isEditable(event.target)) {
        globalDetector.reset();
        return;
      }
      const result = globalDetector.handleKey(event, opts);
      if (result.kind === 'scan') {
        event.preventDefault();
        onScanRef.current?.(result.code);
      }
    };
    document.addEventListener('keydown', listener, true);
    return () => document.removeEventListener('keydown', listener, true);
  }, [captureGlobally, minLength, maxKeyGapMs, scanTerminator]);

  return (
    <Input
      enterKeyHint="search"
      inputMode="search"
      autoComplete="off"
      spellCheck={false}
      {...rest}
      ref={merged}
      type="search"
      label={label ?? t('search.label')}
      hideLabel={hideLabel}
      className={cx('pos-search', className)}
      disabled={disabled}
      readOnly={readOnly}
      value={value}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onBlur={(event) => {
        detector.reset();
        onBlur?.(event);
      }}
      prefix={<Icon name="search" />}
      suffix={
        value !== '' && !disabled && !readOnly ? (
          <button
            type="button"
            className="pos-search__clear"
            aria-label={t('search.clear')}
            onClick={clear}
          >
            <Icon name="x" />
          </button>
        ) : undefined
      }
    />
  );
}
