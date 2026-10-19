import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react';

import { cx } from '../../foundation/cx.js';
import { Icon } from '../../foundation/Icon.js';
import { useUi } from '../../foundation/UiProvider.js';
import { mergeRefs } from '../Field/internal.js';

export type KeypadMode = 'digits' | 'pin' | 'amount';

export interface KeypadProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'onChange' | 'defaultValue' | 'style' | 'children'
> {
  /**
   * Entered value as a string. `digits`: "12.5". `pin`: "1234". `amount`: integer minor units ("1250" is $12.50),
   * matching the domain layer's money representation.
   */
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onChange?: (value: string) => void;
  /** `pin` masks the display and announces only a digit count; `amount` enters minor units. */
  readonly mode?: KeypadMode;
  /** `digits` mode only: shows a decimal key and allows one decimal point. */
  readonly decimal?: boolean;
  /** `digits` mode only: maximum digits after the decimal point. */
  readonly decimalPlaces?: number;
  /** Maximum digits. Defaults: pin 6, amount 9, digits 12. */
  readonly maxLength?: number;
  /** `amount` mode: ISO 4217 code for display; defaults to the provider's currency. */
  readonly currency?: string;
  /** Extra action key, e.g. "Enter" or "Pay". Also triggered by the physical Enter key. */
  readonly actionLabel?: ReactNode;
  readonly onAction?: (value: string) => void;
  readonly actionDisabled?: boolean;
  /** Shows the Clear key (default true). */
  readonly showClear?: boolean;
  /** Hides the built-in display when the value is shown elsewhere. */
  readonly hideDisplay?: boolean;
  /** `digits` mode: display text when empty. */
  readonly placeholder?: string;
  readonly disabled?: boolean;
  /** Accessible name of the keypad group. Defaults to "Keypad". */
  readonly label?: string;
  readonly ref?: Ref<HTMLDivElement>;
}

const DEFAULT_MAX: Record<KeypadMode, number> = { pin: 6, amount: 9, digits: 12 };
const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
const NATIVE_CONTROL_KEYS = new Set(['backspace', 'clear', 'action']);

interface Rules {
  readonly mode: KeypadMode;
  readonly decimal: boolean;
  readonly decimalPlaces: number;
  readonly maxLength: number;
}

function digitCount(value: string): number {
  return value.replace('.', '').length;
}

function pressDigit(current: string, digit: string, rules: Rules): string {
  if (digitCount(current) >= rules.maxLength) return current;
  if (rules.mode === 'pin') return current + digit;
  if (rules.mode === 'amount') return (current + digit).replace(/^0+/, '');
  const dot = current.indexOf('.');
  if (dot >= 0 && current.length - dot - 1 >= rules.decimalPlaces) return current;
  if (current === '0' || current === '') return digit;
  return current + digit;
}

function pressDecimal(current: string, rules: Rules): string {
  if (rules.mode !== 'digits' || !rules.decimal || rules.decimalPlaces < 1 || current.includes('.'))
    return current;
  if (digitCount(current) >= rules.maxLength) return current;
  return current === '' ? '0.' : `${current}.`;
}

function decimalSeparator(locale: string): string {
  return (
    new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === 'decimal')
      ?.value ?? '.'
  );
}

/**
 * Numeric keypad for PIN, cash amounts and quantities. Keys are 64 px touch targets. Reacts to the physical
 * keyboard (digits, Backspace, Enter, decimal point) while focus is inside it. Quick-tender chips are not part of it.
 */
export function Keypad({
  value,
  defaultValue = '',
  onChange,
  mode = 'digits',
  decimal = false,
  decimalPlaces = 3,
  maxLength,
  currency,
  actionLabel,
  onAction,
  actionDisabled = false,
  showClear = true,
  hideDisplay = false,
  placeholder = '0',
  disabled = false,
  label,
  className,
  ref,
  ...rest
}: KeypadProps) {
  const { t, format, locale } = useUi();
  const [inner, setInner] = useState(defaultValue);
  const current = value ?? inner;
  const max = maxLength ?? DEFAULT_MAX[mode];
  const rules: Rules = { mode, decimal, decimalPlaces, maxLength: max };
  const hasDecimalKey = mode === 'digits' && decimal;
  const hasAction = actionLabel !== undefined && actionLabel !== null;

  const commit = (next: string) => {
    if (next === current) return;
    setInner(next);
    onChange?.(next);
  };
  const rootRef = useRef<HTMLDivElement>(null);
  const mergedRef = useMemo(() => mergeRefs(rootRef, ref), [ref]);
  const triggerAction = () => {
    if (!actionDisabled && !disabled) onAction?.(current);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || disabled) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const { key } = event;
    if (/^[0-9]$/.test(key)) {
      event.preventDefault();
      commit(pressDigit(current, key, rules));
    } else if ((key === '.' || key === ',') && hasDecimalKey) {
      event.preventDefault();
      commit(pressDecimal(current, rules));
    } else if (key === 'Backspace') {
      event.preventDefault();
      commit(current.slice(0, -1));
    } else if (key === 'Enter' && onAction) {
      // Enter on Backspace/Clear/action keys keeps its native activation; elsewhere it submits.
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!NATIVE_CONTROL_KEYS.has(target?.dataset.keypadKey ?? '')) {
        event.preventDefault();
        triggerAction();
      }
    }
  };

  // A native listener (not a React prop) because the group is a non-interactive element that
  // handles keys only on behalf of the buttons inside it.
  const latestKeyHandler = useRef(handleKeyDown);
  useEffect(() => {
    latestKeyHandler.current = handleKeyDown;
  });
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const listener = (event: KeyboardEvent) => latestKeyHandler.current(event);
    root.addEventListener('keydown', listener);
    return () => root.removeEventListener('keydown', listener);
  }, []);

  const display = (() => {
    if (mode === 'pin') {
      return (
        <>
          <span className="pos-keypad__dots" aria-hidden="true">
            {Array.from({ length: max }, (_, index) => (
              <span
                key={index}
                className={cx(
                  'pos-keypad__dot',
                  index < current.length && 'pos-keypad__dot--filled',
                )}
              />
            ))}
          </span>
          <span className="pos-sr-only">{t('keypad.pinCount', { count: current.length })}</span>
        </>
      );
    }
    if (mode === 'amount') return format.money(Number(current || '0'), currency);
    if (current === '') return <span className="pos-keypad__placeholder">{placeholder}</span>;
    return current.replace('.', decimalSeparator(locale));
  })();

  return (
    <div
      {...rest}
      ref={mergedRef}
      role="group"
      aria-label={label ?? t('keypad.label')}
      className={cx('pos-keypad', `pos-keypad--${mode}`, className)}
    >
      {hideDisplay ? null : (
        <div className="pos-keypad__display pos-num" role="status">
          {display}
        </div>
      )}
      <div className="pos-keypad__grid">
        {DIGITS.map((digit) => (
          <button
            key={digit}
            type="button"
            className="pos-keypad__key"
            data-keypad-key={digit}
            disabled={disabled}
            onClick={() => commit(pressDigit(current, digit, rules))}
          >
            {digit}
          </button>
        ))}
        {hasDecimalKey ? (
          <button
            type="button"
            className="pos-keypad__key"
            data-keypad-key="decimal"
            aria-label={t('keypad.decimal')}
            disabled={disabled}
            onClick={() => commit(pressDecimal(current, rules))}
          >
            {decimalSeparator(locale)}
          </button>
        ) : (
          <span aria-hidden="true" />
        )}
        <button
          type="button"
          className="pos-keypad__key"
          data-keypad-key="0"
          disabled={disabled}
          onClick={() => commit(pressDigit(current, '0', rules))}
        >
          0
        </button>
        <button
          type="button"
          className="pos-keypad__key pos-keypad__key--control"
          data-keypad-key="backspace"
          aria-label={t('keypad.backspace')}
          disabled={disabled}
          onClick={() => commit(current.slice(0, -1))}
        >
          <Icon name="backspace" size="1.5em" />
        </button>
        {showClear ? (
          <button
            type="button"
            className={cx(
              'pos-keypad__key pos-keypad__key--control',
              hasAction ? 'pos-keypad__key--clear' : 'pos-keypad__key--full',
            )}
            data-keypad-key="clear"
            disabled={disabled}
            onClick={() => commit('')}
          >
            {t('keypad.clear')}
          </button>
        ) : null}
        {hasAction ? (
          <button
            type="button"
            className={cx(
              'pos-keypad__key pos-keypad__key--action',
              showClear ? 'pos-keypad__key--wide' : 'pos-keypad__key--full',
            )}
            data-keypad-key="action"
            disabled={disabled || actionDisabled}
            onClick={triggerAction}
          >
            {actionLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}
