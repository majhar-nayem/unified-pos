import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

import { cx } from '../../foundation/cx.js';
import { useUi } from '../../foundation/UiProvider.js';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'tender';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  readonly variant?: ButtonVariant;
  /** `tender` is the 72 px primary tender button (Cash, Card). Others never drop below the surface's control height. */
  readonly size?: ButtonSize;
  /** Disables the button and announces busy state. Use for in-flight actions off the checkout critical path. */
  readonly loading?: boolean;
  readonly iconStart?: ReactNode;
  readonly iconEnd?: ReactNode;
  readonly fullWidth?: boolean;
  readonly ref?: Ref<HTMLButtonElement>;
  readonly children: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  iconStart,
  iconEnd,
  fullWidth = false,
  className,
  disabled,
  children,
  ref,
  ...rest
}: ButtonProps) {
  const { t } = useUi();
  return (
    <button
      type="button"
      {...rest}
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'pos-button',
        `pos-button--${variant}`,
        `pos-button--${size}`,
        fullWidth && 'pos-button--full',
        className,
      )}
    >
      {iconStart}
      <span className="pos-button__label">{children}</span>
      {iconEnd}
      {loading ? <span className="pos-sr-only">{t('ui.loading')}</span> : null}
    </button>
  );
}
