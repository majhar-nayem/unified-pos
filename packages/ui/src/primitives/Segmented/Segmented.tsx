import { useId, useState, type ReactNode, type Ref } from 'react';

import { cx } from '../../foundation/cx.js';
import { Icon, type IconName } from '../../foundation/Icon.js';

export interface SegmentedOption {
  readonly value: string;
  readonly label: ReactNode;
  readonly icon?: IconName;
  readonly disabled?: boolean;
}

export interface SegmentedProps {
  /** Accessible name of the group (not shown). */
  readonly label: string;
  /** 2 to 5 options. */
  readonly options: ReadonlyArray<SegmentedOption>;
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onValueChange?: (value: string) => void;
  readonly name?: string;
  readonly size?: 'md' | 'lg';
  readonly fullWidth?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly id?: string;
  readonly ref?: Ref<HTMLDivElement>;
}

/**
 * Single-choice segmented control (tender type, quantity step, view mode). Native radios inside a
 * `role="radiogroup"`: one tab stop, arrow keys move and select, as the ARIA pattern requires.
 */
export function Segmented({
  label,
  options,
  value,
  defaultValue,
  onValueChange,
  name,
  size = 'md',
  fullWidth = false,
  disabled = false,
  className,
  id,
  ref,
}: SegmentedProps) {
  const generatedName = useId();
  const [inner, setInner] = useState(defaultValue ?? options[0]?.value);
  const current = value ?? inner;
  return (
    <div
      ref={ref}
      id={id}
      role="radiogroup"
      aria-label={label}
      className={cx(
        'pos-segmented',
        `pos-segmented--${size}`,
        fullWidth && 'pos-segmented--full',
        className,
      )}
    >
      {options.map((option) => {
        const isDisabled = disabled || option.disabled;
        return (
          <label
            key={option.value}
            className={cx('pos-segmented__option', isDisabled && 'pos-segmented__option--disabled')}
          >
            <input
              type="radio"
              className="pos-segmented__input pos-sr-only"
              name={name ?? generatedName}
              value={option.value}
              checked={current === option.value}
              disabled={isDisabled}
              onChange={() => {
                setInner(option.value);
                onValueChange?.(option.value);
              }}
            />
            <span className="pos-segmented__text">
              {option.icon ? <Icon name={option.icon} /> : null}
              {option.label}
            </span>
          </label>
        );
      })}
    </div>
  );
}
