import type { ReactNode, Ref, SelectHTMLAttributes } from 'react';

import { cx } from '../../foundation/cx.js';
import { Icon } from '../../foundation/Icon.js';
import { Field, fieldDescribedBy, useFieldIds } from '../Field/Field.js';
import { hasContent } from '../Field/internal.js';
import type { ControlSize } from '../Input/Input.js';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'size' | 'style'
> {
  readonly size?: ControlSize;
  readonly label: ReactNode;
  readonly hideLabel?: boolean;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly optional?: boolean;
  readonly invalid?: boolean;
  /** Adds a disabled empty first option with this text, selected until the user chooses. */
  readonly placeholder?: string;
  /** Shorthand for `<option>` children. */
  readonly options?: ReadonlyArray<SelectOption>;
  readonly ref?: Ref<HTMLSelectElement>;
  readonly children?: ReactNode;
}

/** Native `<select>` with the shared field chrome. Native keeps the OS picker on touch devices. */
export function Select({
  size = 'md',
  label,
  hideLabel = false,
  hint,
  error,
  optional = false,
  invalid,
  placeholder,
  options,
  className,
  id,
  required,
  disabled,
  value,
  defaultValue,
  children,
  ref,
  'aria-describedby': describedByProp,
  ...rest
}: SelectProps) {
  const ids = useFieldIds(id);
  const isInvalid = invalid ?? hasContent(error);
  const initial =
    value === undefined && defaultValue === undefined && placeholder !== undefined
      ? ''
      : defaultValue;
  return (
    <Field
      ids={ids}
      label={label}
      hideLabel={hideLabel}
      hint={hint}
      error={error}
      required={required}
      optional={optional}
      className={className}
    >
      <div
        className={cx(
          'pos-select',
          `pos-select--${size}`,
          isInvalid && 'pos-select--invalid',
          disabled && 'pos-select--disabled',
        )}
      >
        <select
          {...rest}
          ref={ref}
          id={ids.controlId}
          className="pos-select__control"
          required={required}
          disabled={disabled}
          {...(value !== undefined ? { value } : { defaultValue: initial })}
          aria-invalid={isInvalid || undefined}
          aria-describedby={fieldDescribedBy(ids, { hint, error, extra: describedByProp })}
        >
          {placeholder !== undefined ? (
            <option value="" disabled>
              {placeholder}
            </option>
          ) : null}
          {options?.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
          {children}
        </select>
        <Icon name="chevron-down" className="pos-select__chevron" />
      </div>
    </Field>
  );
}
