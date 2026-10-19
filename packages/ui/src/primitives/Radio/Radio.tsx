import {
  createContext,
  useContext,
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react';

import { cx } from '../../foundation/cx.js';
import { Field, useFieldIds } from '../Field/Field.js';

interface RadioGroupContextValue {
  readonly name: string;
  readonly value: string | undefined;
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly setValue: (value: string) => void;
}

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null);

export interface RadioGroupProps {
  /** Group label, rendered as a legend. */
  readonly label: ReactNode;
  readonly hideLabel?: boolean;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly optional?: boolean;
  readonly required?: boolean;
  readonly name?: string;
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onValueChange?: (value: string) => void;
  readonly disabled?: boolean;
  readonly orientation?: 'vertical' | 'horizontal';
  readonly className?: string;
  readonly id?: string;
  readonly children: ReactNode;
}

/** `role="radiogroup"` over native radios, so arrow keys and the single tab stop come from the platform. */
export function RadioGroup({
  label,
  hideLabel,
  hint,
  error,
  optional,
  required,
  name,
  value,
  defaultValue,
  onValueChange,
  disabled = false,
  orientation = 'vertical',
  className,
  id,
  children,
}: RadioGroupProps) {
  const ids = useFieldIds(id);
  const generatedName = useId();
  const [inner, setInner] = useState(defaultValue);
  const current = value ?? inner;
  const invalid = Boolean(error);
  const context: RadioGroupContextValue = {
    name: name ?? generatedName,
    value: current,
    disabled,
    invalid,
    setValue: (next) => {
      setInner(next);
      onValueChange?.(next);
    },
  };
  return (
    <RadioGroupContext.Provider value={context}>
      <Field
        as="fieldset"
        ids={ids}
        label={label}
        hideLabel={hideLabel}
        hint={hint}
        error={error}
        optional={optional}
        required={required}
        className={className}
        role="radiogroup"
        aria-required={required || undefined}
        aria-invalid={invalid || undefined}
      >
        <div className={cx('pos-radio-group__items', `pos-radio-group__items--${orientation}`)}>
          {children}
        </div>
      </Field>
    </RadioGroupContext.Provider>
  );
}

export interface RadioProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'size' | 'style' | 'prefix' | 'value'
> {
  readonly value: string;
  readonly label?: ReactNode;
  readonly hint?: ReactNode;
  readonly ref?: Ref<HTMLInputElement>;
}

export function Radio({
  value,
  label,
  hint,
  className,
  disabled,
  id,
  ref,
  onChange,
  ...rest
}: RadioProps) {
  const group = useContext(RadioGroupContext);
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = `${inputId}-hint`;
  const labelId = `${inputId}-label`;
  const isDisabled = disabled || group?.disabled;
  const groupProps = group
    ? {
        name: group.name,
        checked: group.value === value,
        onChange: (event: Parameters<NonNullable<typeof onChange>>[0]) => {
          onChange?.(event);
          group.setValue(value);
        },
      }
    : { onChange };
  return (
    <label
      className={cx(
        'pos-radio',
        isDisabled && 'pos-radio--disabled',
        group?.invalid && 'pos-radio--invalid',
        className,
      )}
    >
      <input
        {...rest}
        {...groupProps}
        ref={ref}
        id={inputId}
        type="radio"
        value={value}
        className="pos-radio__input"
        disabled={isDisabled}
        aria-labelledby={label ? labelId : undefined}
        aria-describedby={hint ? hintId : rest['aria-describedby']}
      />
      <span className="pos-radio__dot" aria-hidden="true" />
      {label || hint ? (
        <span className="pos-radio__text">
          {label ? (
            <span id={labelId} className="pos-radio__label">
              {label}
            </span>
          ) : null}
          {hint ? (
            <span id={hintId} className="pos-radio__hint">
              {hint}
            </span>
          ) : null}
        </span>
      ) : null}
    </label>
  );
}
