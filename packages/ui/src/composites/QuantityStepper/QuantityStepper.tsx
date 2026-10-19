import { useId, useState, type HTMLAttributes, type Ref } from 'react';

import { cx } from '../../foundation/cx.js';
import { Icon } from '../../foundation/Icon.js';
import { useUi } from '../../foundation/UiProvider.js';

export interface QuantityStepperProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'onChange' | 'defaultValue' | 'children'
> {
  /** Controlled quantity. */
  readonly value?: number;
  readonly defaultValue?: number;
  readonly onChange?: (next: number) => void;
  readonly min?: number;
  readonly max?: number;
  /** Amount added or removed per tap. For weighed items this is usually 0.1 or 0.05. */
  readonly step?: number;
  /** Decimal places for weighed items (kg). Defaults to whole units. */
  readonly fractionDigits?: number;
  /** Unit text shown after the quantity, e.g. "kg". */
  readonly unit?: string;
  /** Shows the quantity without the − / + buttons. */
  readonly readOnly?: boolean;
  readonly disabled?: boolean;
  /** Overrides the group name ("Quantity"), e.g. "Quantity of Oat Milk 1L". */
  readonly label?: string;
  readonly ref?: Ref<HTMLDivElement>;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** − / quantity / + with 48 px buttons. The readout is a polite live region so changes are announced. */
export function QuantityStepper({
  value,
  defaultValue = 1,
  onChange,
  min = 0,
  max = Number.POSITIVE_INFINITY,
  step = 1,
  fractionDigits = 0,
  unit,
  readOnly = false,
  disabled = false,
  label,
  className,
  ref,
  ...rest
}: QuantityStepperProps) {
  const { t, format } = useUi();
  const [internal, setInternal] = useState(defaultValue);
  const current = value ?? internal;
  const readoutId = useId();

  const commit = (next: number) => {
    const clamped = round(Math.min(max, Math.max(min, next)), fractionDigits);
    if (clamped === current) return;
    if (value === undefined) setInternal(clamped);
    onChange?.(clamped);
  };

  const atMin = current <= min;
  const atMax = current >= max;
  const text = format.number(current, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });

  return (
    <div
      role="group"
      aria-label={label ?? t('quantityStepper.label')}
      {...rest}
      ref={ref}
      className={cx(
        'pos-qty',
        readOnly && 'pos-qty--readonly',
        disabled && 'pos-qty--disabled',
        className,
      )}
    >
      {readOnly ? null : (
        <button
          type="button"
          className="pos-qty__button"
          aria-label={t('quantityStepper.decrease')}
          aria-controls={readoutId}
          aria-disabled={atMin || disabled || undefined}
          disabled={disabled}
          onClick={() => {
            if (!atMin) commit(current - step);
          }}
        >
          <Icon name="minus" />
        </button>
      )}
      <output
        id={readoutId}
        className="pos-qty__value pos-num"
        aria-live="polite"
        aria-atomic="true"
      >
        {text}
        {unit ? <span className="pos-qty__unit">{unit}</span> : null}
      </output>
      {readOnly ? null : (
        <button
          type="button"
          className="pos-qty__button"
          aria-label={t('quantityStepper.increase')}
          aria-controls={readoutId}
          aria-disabled={atMax || disabled || undefined}
          disabled={disabled}
          onClick={() => {
            if (!atMax) commit(current + step);
          }}
        >
          <Icon name="plus" />
        </button>
      )}
    </div>
  );
}
