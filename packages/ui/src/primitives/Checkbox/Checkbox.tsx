import {
  useEffect,
  useId,
  useMemo,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react';

import { cx } from '../../foundation/cx.js';
import { Icon } from '../../foundation/Icon.js';
import { mergeRefs } from '../Field/internal.js';

export interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'size' | 'style' | 'prefix'
> {
  /** Visible label. Provide `aria-label` instead when the label is shown elsewhere. */
  readonly label?: ReactNode;
  readonly hint?: ReactNode;
  /** Mixed state for a "select all" parent. The checked value still decides what a click does next. */
  readonly indeterminate?: boolean;
  readonly invalid?: boolean;
  readonly ref?: Ref<HTMLInputElement>;
}

export function Checkbox({
  label,
  hint,
  indeterminate = false,
  invalid = false,
  className,
  disabled,
  id,
  ref,
  'aria-describedby': describedByProp,
  ...rest
}: CheckboxProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = `${inputId}-hint`;
  const labelId = `${inputId}-label`;
  const innerRef = useRef<HTMLInputElement>(null);
  const merged = useMemo(() => mergeRefs(innerRef, ref), [ref]);

  useEffect(() => {
    if (innerRef.current) innerRef.current.indeterminate = indeterminate;
  });

  const describedBy =
    [hint ? hintId : null, describedByProp].filter(Boolean).join(' ') || undefined;
  return (
    <label
      className={cx(
        'pos-checkbox',
        invalid && 'pos-checkbox--invalid',
        disabled && 'pos-checkbox--disabled',
        className,
      )}
    >
      <input
        {...rest}
        ref={merged}
        id={inputId}
        type="checkbox"
        className="pos-checkbox__input"
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-labelledby={label ? labelId : undefined}
        aria-describedby={describedBy}
      />
      <span className="pos-checkbox__box" aria-hidden="true">
        <Icon name="check" className="pos-checkbox__mark pos-checkbox__mark--check" />
        <Icon name="minus" className="pos-checkbox__mark pos-checkbox__mark--mixed" />
      </span>
      {label || hint ? (
        <span className="pos-checkbox__text">
          {label ? (
            <span id={labelId} className="pos-checkbox__label">
              {label}
            </span>
          ) : null}
          {hint ? (
            <span id={hintId} className="pos-checkbox__hint">
              {hint}
            </span>
          ) : null}
        </span>
      ) : null}
    </label>
  );
}
