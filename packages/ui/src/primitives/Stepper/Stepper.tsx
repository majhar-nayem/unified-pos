import type { HTMLAttributes, ReactNode, Ref } from 'react';

import { cx } from '../../foundation/cx.js';
import { Icon } from '../../foundation/Icon.js';
import { useUi } from '../../foundation/UiProvider.js';

export type StepState = 'complete' | 'current' | 'upcoming' | 'error';

export interface StepperStep {
  readonly id: string;
  readonly label: ReactNode;
  readonly description?: ReactNode;
  /** Overrides the state derived from `current` (use `error` for a step that failed validation). */
  readonly state?: StepState;
  readonly disabled?: boolean;
}

export interface StepperProps extends Omit<HTMLAttributes<HTMLOListElement>, 'children' | 'style'> {
  readonly steps: ReadonlyArray<StepperStep>;
  /** Zero-based index of the current step. Earlier steps read as complete, later ones as upcoming. */
  readonly current: number;
  /** Makes reached (complete, current or error) steps buttons that call this. Upcoming steps are never clickable. */
  readonly onStepClick?: (index: number, step: StepperStep) => void;
  readonly orientation?: 'horizontal' | 'vertical';
  /** Accessible name of the list. Defaults to "Progress". */
  readonly label?: string;
  readonly ref?: Ref<HTMLOListElement>;
}

/** Multi-step progress indicator for wizards (enrolment, import). An ordered list; state is icon plus text. */
export function Stepper({
  steps,
  current,
  onStepClick,
  orientation = 'horizontal',
  label,
  className,
  ref,
  ...rest
}: StepperProps) {
  const { t } = useUi();
  return (
    <ol
      {...rest}
      ref={ref}
      aria-label={label ?? t('stepper.label')}
      className={cx('pos-stepper', `pos-stepper--${orientation}`, className)}
    >
      {steps.map((step, index) => {
        const state: StepState =
          step.state ?? (index < current ? 'complete' : index === current ? 'current' : 'upcoming');
        const clickable = Boolean(onStepClick) && !step.disabled && state !== 'upcoming';
        const content = (
          <>
            <span className="pos-stepper__marker" aria-hidden="true">
              {state === 'complete' ? (
                <Icon name="check" />
              ) : state === 'error' ? (
                <Icon name="alert" />
              ) : (
                index + 1
              )}
            </span>
            <span className="pos-stepper__text">
              <span className="pos-stepper__label">
                {step.label}
                <span className="pos-sr-only">, {t(`stepper.state.${state}`)}</span>
              </span>
              {step.description ? (
                <span className="pos-stepper__description">{step.description}</span>
              ) : null}
            </span>
          </>
        );
        return (
          <li
            key={step.id}
            className={cx('pos-stepper__item', `pos-stepper__item--${state}`)}
            aria-current={index === current ? 'step' : undefined}
          >
            {clickable ? (
              <button
                type="button"
                className="pos-stepper__step pos-stepper__step--button"
                onClick={() => onStepClick?.(index, step)}
              >
                {content}
              </button>
            ) : (
              <div className="pos-stepper__step">{content}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
