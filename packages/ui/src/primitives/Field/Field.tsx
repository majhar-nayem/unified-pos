import { useId, type HTMLAttributes, type ReactNode } from 'react';

import { cx } from '../../foundation/cx.js';
import { Icon } from '../../foundation/Icon.js';
import { useUi } from '../../foundation/UiProvider.js';

import { hasContent } from './internal.js';

export interface FieldIds {
  /** id of the control the label points at. */
  readonly controlId: string;
  readonly labelId: string;
  readonly hintId: string;
  readonly errorId: string;
}

/** Derives the stable id set a form control and its Field share. Pass the control's own `id` to keep it. */
export function useFieldIds(id?: string): FieldIds {
  const generated = useId();
  const base = id ?? generated;
  return {
    controlId: base,
    labelId: `${base}-label`,
    hintId: `${base}-hint`,
    errorId: `${base}-error`,
  };
}

/** Builds the `aria-describedby` value for a control: its hint, its error, and any caller-supplied ids. */
export function fieldDescribedBy(
  ids: FieldIds,
  parts: {
    readonly hint?: ReactNode;
    readonly error?: ReactNode;
    readonly extra?: string | undefined;
  },
): string | undefined {
  const list = [
    hasContent(parts.hint) ? ids.hintId : null,
    hasContent(parts.error) ? ids.errorId : null,
    parts.extra || null,
  ].filter(Boolean);
  return list.length > 0 ? list.join(' ') : undefined;
}

export interface FieldProps extends Omit<HTMLAttributes<HTMLElement>, 'children' | 'style' | 'id'> {
  readonly ids: FieldIds;
  readonly label: ReactNode;
  /** Keeps the label for assistive tech but hides it visually (toolbar search, inline controls). */
  readonly hideLabel?: boolean;
  readonly hint?: ReactNode;
  /** Error text. Shown with an icon so it is never colour alone; wire `aria-invalid` on the control yourself. */
  readonly error?: ReactNode;
  /** Adds a visual required marker. Put `required` on the control as well. */
  readonly required?: boolean;
  /** Shows "(optional)". Ignored when `required`. */
  readonly optional?: boolean;
  /** `fieldset` renders the label as a `legend` for groups of controls (radio groups). */
  readonly as?: 'div' | 'fieldset';
  readonly children: ReactNode;
}

/** Shared label, hint and error wrapper used by Input, Select, Combobox, Search and the group controls. */
export function Field({
  ids,
  label,
  hideLabel = false,
  hint,
  error,
  required = false,
  optional = false,
  as = 'div',
  className,
  children,
  ...rest
}: FieldProps) {
  const { t } = useUi();
  const labelClass = cx('pos-field__label', hideLabel && 'pos-sr-only');
  const labelContent = (
    <>
      {label}
      {required ? (
        <span className="pos-field__required" aria-hidden="true">
          *
        </span>
      ) : optional ? (
        <span className="pos-field__optional">({t('ui.optional')})</span>
      ) : null}
    </>
  );
  const body = (
    <>
      {hasContent(hint) ? (
        <p id={ids.hintId} className="pos-field__hint">
          {hint}
        </p>
      ) : null}
      {children}
      {hasContent(error) ? (
        <p id={ids.errorId} className="pos-field__error">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      ) : null}
    </>
  );

  if (as === 'fieldset') {
    return (
      <fieldset
        {...rest}
        className={cx('pos-field', className)}
        aria-describedby={fieldDescribedBy(ids, { hint, error })}
      >
        <legend id={ids.labelId} className={cx(labelClass, 'pos-field__legend')}>
          {labelContent}
        </legend>
        {body}
      </fieldset>
    );
  }

  return (
    <div {...rest} className={cx('pos-field', className)}>
      <label id={ids.labelId} htmlFor={ids.controlId} className={labelClass}>
        {labelContent}
      </label>
      {body}
    </div>
  );
}
