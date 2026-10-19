import {
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';

import { cx } from '../../foundation/cx.js';
import { Icon } from '../../foundation/Icon.js';
import { useUi } from '../../foundation/UiProvider.js';
import { Field, fieldDescribedBy, useFieldIds } from '../Field/Field.js';
import { hasContent } from '../Field/internal.js';
import type { ControlSize } from '../Input/Input.js';

export interface ComboboxOption {
  readonly value: string;
  /** Text shown in the field once selected, and the default filter target. */
  readonly label: string;
  readonly description?: ReactNode;
  readonly disabled?: boolean;
}

export interface ComboboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'size' | 'prefix' | 'style' | 'type' | 'value' | 'defaultValue' | 'onSelect' | 'role' | 'onChange'
> {
  readonly label: ReactNode;
  readonly hideLabel?: boolean;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly optional?: boolean;
  readonly invalid?: boolean;
  readonly size?: ControlSize;
  readonly options: ReadonlyArray<ComboboxOption>;
  /** Selected option value (controlled). `null` is "nothing selected". */
  readonly value?: string | null;
  readonly defaultValue?: string | null;
  /** Fires when an option is chosen with Enter or a click. */
  readonly onSelect?: (option: ComboboxOption) => void;
  /** Text in the field (controlled). While unset, the field shows what is typed, else the selected label. */
  readonly inputValue?: string;
  /** Fires as the person types and when a selection rewrites the field text. */
  readonly onInputChange?: (inputValue: string) => void;
  /** Async results are on their way. Shows a static indicator; options already present stay usable. */
  readonly loading?: boolean;
  /** Replaces the "No results" text. */
  readonly emptyMessage?: ReactNode;
  /** Custom filter, or `false` when the caller filters (server search) and `options` is already the result. */
  readonly filter?: false | ((option: ComboboxOption, query: string) => boolean);
  readonly defaultOpen?: boolean;
  readonly ref?: Ref<HTMLInputElement>;
}

const defaultFilter = (option: ComboboxOption, query: string) =>
  option.label.toLowerCase().includes(query.trim().toLowerCase());

/** ARIA 1.2 combobox with a listbox popup (list autocomplete). DOM focus stays in the input throughout. */
export function Combobox({
  label,
  hideLabel = false,
  hint,
  error,
  optional = false,
  invalid,
  size = 'md',
  options,
  value: valueProp,
  defaultValue = null,
  onSelect,
  inputValue: inputValueProp,
  onInputChange,
  loading = false,
  emptyMessage,
  filter,
  defaultOpen = false,
  className,
  id,
  required,
  disabled,
  readOnly,
  placeholder,
  ref,
  onKeyDown,
  onBlur,
  onClick,
  'aria-describedby': describedByProp,
  ...rest
}: ComboboxProps) {
  const { t } = useUi();
  const ids = useFieldIds(id);
  const listboxId = `${ids.controlId}-listbox`;
  const optionId = (index: number) => `${ids.controlId}-option-${index}`;

  const [open, setOpen] = useState(defaultOpen);
  const [innerValue, setInnerValue] = useState<string | null>(defaultValue);
  /** Text the person typed since last selecting or leaving; null while the field shows the selection. */
  const [typed, setTyped] = useState<string | null>(null);
  const [activeValue, setActiveValue] = useState<string | null>(null);

  const selectedValue = valueProp === undefined ? innerValue : valueProp;
  const selected = options.find((option) => option.value === selectedValue) ?? null;
  const dirty = typed !== null;
  const inputValue = inputValueProp ?? (dirty ? typed : (selected?.label ?? ''));
  const query = dirty ? (inputValueProp ?? typed) : '';

  const visible =
    filter === false
      ? options
      : options.filter((option) => (filter ?? defaultFilter)(option, query));
  const popupOpen = open && !disabled && !readOnly;
  const expanded = popupOpen && visible.length > 0;
  const firstEnabled = visible.find((option) => !option.disabled) ?? null;
  const explicit =
    visible.find((option) => option.value === activeValue && !option.disabled) ?? null;
  const active = expanded ? (explicit ?? (dirty ? firstEnabled : null)) : null;
  const activeIndex = active ? visible.indexOf(active) : -1;

  const isInvalid = invalid ?? hasContent(error);

  const choose = (option: ComboboxOption) => {
    if (option.disabled) return;
    if (valueProp === undefined) setInnerValue(option.value);
    setTyped(null);
    setActiveValue(null);
    setOpen(false);
    onInputChange?.(option.label);
    onSelect?.(option);
  };

  const move = (direction: 1 | -1) => {
    const enabled = visible.filter((option) => !option.disabled);
    if (enabled.length === 0) return;
    if (!expanded) {
      setOpen(true);
      setActiveValue(
        (selected && enabled.includes(selected)
          ? selected
          : enabled[direction === 1 ? 0 : enabled.length - 1]
        )?.value ?? null,
      );
      return;
    }
    const position = active ? enabled.indexOf(active) : -1;
    const next =
      position === -1
        ? enabled[direction === 1 ? 0 : enabled.length - 1]
        : enabled[(position + direction + enabled.length) % enabled.length];
    setActiveValue(next?.value ?? null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      if (active) {
        event.preventDefault();
        choose(active);
      }
    } else if (event.key === 'Escape' && popupOpen) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  const status = !popupOpen
    ? ''
    : loading
      ? t('combobox.loading')
      : visible.length > 0
        ? t('combobox.results', { count: visible.length })
        : t('combobox.empty');

  return (
    <Field
      ids={ids}
      label={label}
      hideLabel={hideLabel}
      hint={hint}
      error={error}
      required={required}
      optional={optional}
      className={cx('pos-combobox', className)}
    >
      <div
        className={cx(
          'pos-input',
          `pos-input--${size}`,
          isInvalid && 'pos-input--invalid',
          disabled && 'pos-input--disabled',
          readOnly && 'pos-input--readonly',
        )}
      >
        <input
          {...rest}
          ref={ref}
          id={ids.controlId}
          type="text"
          role="combobox"
          className="pos-input__control"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={expanded ? listboxId : undefined}
          aria-activedescendant={active ? optionId(activeIndex) : undefined}
          aria-invalid={isInvalid || undefined}
          aria-busy={loading || undefined}
          aria-describedby={fieldDescribedBy(ids, { hint, error, extra: describedByProp })}
          required={required}
          disabled={disabled}
          readOnly={readOnly}
          placeholder={placeholder}
          value={inputValue}
          onChange={(event) => {
            setTyped(event.target.value);
            setActiveValue(null);
            setOpen(true);
            onInputChange?.(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          onClick={(event) => {
            onClick?.(event);
            setOpen(true);
          }}
          onBlur={(event) => {
            onBlur?.(event);
            setOpen(false);
            setTyped(null);
            setActiveValue(null);
          }}
        />
        <span className="pos-input__affix pos-input__affix--suffix">
          <Icon name="chevron-down" />
        </span>
      </div>
      {popupOpen ? (
        <div className="pos-combobox__popup">
          {visible.length > 0 ? (
            <ul
              id={listboxId}
              role="listbox"
              aria-labelledby={ids.labelId}
              className="pos-combobox__listbox"
              onMouseDown={(event) => event.preventDefault()}
            >
              {visible.map((option, index) => (
                <li
                  key={option.value}
                  id={optionId(index)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={option.value === selectedValue}
                  aria-disabled={option.disabled || undefined}
                  className={cx(
                    'pos-combobox__option',
                    option === active && 'pos-combobox__option--active',
                    option.value === selectedValue && 'pos-combobox__option--selected',
                    option.disabled && 'pos-combobox__option--disabled',
                  )}
                  onMouseMove={() => {
                    if (!option.disabled && option !== active) setActiveValue(option.value);
                  }}
                  onClick={() => choose(option)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') choose(option);
                  }}
                >
                  <span className="pos-combobox__option-label">
                    {option.label}
                    {option.value === selectedValue ? <Icon name="check" /> : null}
                  </span>
                  {option.description ? (
                    <span className="pos-combobox__option-description">{option.description}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {loading ? (
            <div className="pos-combobox__message" aria-hidden="true">
              <Icon name="processing" />
              <span>{t('combobox.loading')}</span>
            </div>
          ) : visible.length === 0 ? (
            <div className="pos-combobox__message" aria-hidden="true">
              {emptyMessage ?? t('combobox.empty')}
            </div>
          ) : null}
        </div>
      ) : null}
      <div role="status" className="pos-sr-only">
        {status}
      </div>
    </Field>
  );
}
