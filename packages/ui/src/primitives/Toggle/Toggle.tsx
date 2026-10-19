import type { InputHTMLAttributes, ReactNode, Ref } from 'react';

import { cx } from '../../foundation/cx.js';
import { Icon } from '../../foundation/Icon.js';

export interface ToggleProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'size' | 'style' | 'prefix' | 'role'
> {
  /** Visible label. Provide `aria-label` instead when the label is shown elsewhere. */
  readonly label?: ReactNode;
  /** Called with the new state; `onChange` still receives the native event. */
  readonly onCheckedChange?: (checked: boolean) => void;
  readonly ref?: Ref<HTMLInputElement>;
}

/** On/off switch (`role="switch"`) for settings that apply immediately. Use Checkbox for form selections. */
export function Toggle({
  label,
  onCheckedChange,
  onChange,
  className,
  disabled,
  ref,
  ...rest
}: ToggleProps) {
  return (
    <label className={cx('pos-toggle', disabled && 'pos-toggle--disabled', className)}>
      <input
        {...rest}
        ref={ref}
        type="checkbox"
        role="switch"
        className="pos-toggle__input"
        disabled={disabled}
        onChange={(event) => {
          onChange?.(event);
          onCheckedChange?.(event.currentTarget.checked);
        }}
      />
      <span className="pos-toggle__track" aria-hidden="true">
        <span className="pos-toggle__thumb">
          <Icon name="check" className="pos-toggle__check" />
        </span>
      </span>
      {label ? <span className="pos-toggle__label">{label}</span> : null}
    </label>
  );
}
