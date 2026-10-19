import type { ButtonHTMLAttributes, Ref } from 'react';

import { cx } from '../../foundation/cx.js';
import { Icon, type IconName } from '../../foundation/Icon.js';

export type IconButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
/** `sm` is the minimum touch size for the surface (48 on POS); `md` and `lg` grow from there. */
export type IconButtonSize = 'sm' | 'md' | 'lg';

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'style' | 'children' | 'aria-label'
> {
  /** Accessible name. Required because the button has no visible text. */
  readonly label: string;
  readonly icon: IconName;
  readonly variant?: IconButtonVariant;
  readonly size?: IconButtonSize;
  readonly ref?: Ref<HTMLButtonElement>;
}

export function IconButton({
  label,
  icon,
  variant = 'secondary',
  size = 'md',
  className,
  ref,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      ref={ref}
      aria-label={label}
      className={cx(
        'pos-icon-button',
        `pos-icon-button--${variant}`,
        `pos-icon-button--${size}`,
        className,
      )}
    >
      <Icon name={icon} />
    </button>
  );
}
