import type { InputHTMLAttributes, ReactNode, Ref } from 'react';

import { cx } from '../../foundation/cx.js';
import { Field, fieldDescribedBy, useFieldIds } from '../Field/Field.js';
import { hasContent } from '../Field/internal.js';

export type InputType = 'text' | 'number' | 'tel' | 'email' | 'password' | 'url' | 'search';
export type ControlSize = 'sm' | 'md' | 'lg';

const defaultInputMode: Partial<
  Record<InputType, InputHTMLAttributes<HTMLInputElement>['inputMode']>
> = {
  tel: 'tel',
  email: 'email',
  url: 'url',
  search: 'search',
};

export interface InputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'size' | 'prefix' | 'style' | 'type'
> {
  readonly type?: InputType;
  readonly size?: ControlSize;
  /** Visible label. Required: every input needs an accessible name. */
  readonly label: ReactNode;
  /** Hides the label visually while keeping it for assistive tech. */
  readonly hideLabel?: boolean;
  readonly hint?: ReactNode;
  /** Error text; also marks the input invalid unless `invalid` is set explicitly. */
  readonly error?: ReactNode;
  /** Shows "(optional)" next to the label. */
  readonly optional?: boolean;
  readonly invalid?: boolean;
  /** Content before the text (currency symbol, icon). Decorative unless it contains its own name. */
  readonly prefix?: ReactNode;
  /** Content after the text (unit, clear button). */
  readonly suffix?: ReactNode;
  readonly ref?: Ref<HTMLInputElement>;
}

export function Input({
  type = 'text',
  size = 'md',
  label,
  hideLabel = false,
  hint,
  error,
  optional = false,
  invalid,
  prefix,
  suffix,
  className,
  id,
  required,
  disabled,
  readOnly,
  inputMode,
  ref,
  'aria-describedby': describedByProp,
  ...rest
}: InputProps) {
  const ids = useFieldIds(id);
  const isInvalid = invalid ?? hasContent(error);
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
          'pos-input',
          `pos-input--${size}`,
          isInvalid && 'pos-input--invalid',
          disabled && 'pos-input--disabled',
          readOnly && 'pos-input--readonly',
        )}
      >
        {hasContent(prefix) ? (
          <span className="pos-input__affix pos-input__affix--prefix">{prefix}</span>
        ) : null}
        <input
          {...rest}
          ref={ref}
          id={ids.controlId}
          type={type}
          className="pos-input__control"
          inputMode={inputMode ?? defaultInputMode[type]}
          required={required}
          disabled={disabled}
          readOnly={readOnly}
          aria-invalid={isInvalid || undefined}
          aria-describedby={fieldDescribedBy(ids, { hint, error, extra: describedByProp })}
        />
        {hasContent(suffix) ? (
          <span className="pos-input__affix pos-input__affix--suffix">{suffix}</span>
        ) : null}
      </div>
    </Field>
  );
}
