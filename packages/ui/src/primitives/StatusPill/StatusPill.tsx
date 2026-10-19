import type { ReactNode } from 'react';

import { cx } from '../../foundation/cx.js';
import { Icon, type IconName } from '../../foundation/Icon.js';
import type { SemanticRole } from '../../tokens.js';

/**
 * StatusPill: a status is always an icon plus a label, never colour alone (docs/04-design-plan.md 3.1).
 * Use `tone` for the semantic roles, or `palette` to take colours from a status palette
 * (table / kds age / payment), e.g. `palette="payment-captured"`.
 */
export type StatusPaletteKey =
  | `table-${'available' | 'occupied' | 'reserved' | 'dirty' | 'blocked'}`
  | `kds-age-${'fresh' | 'aging' | 'late' | 'critical'}`
  | `payment-${'processing' | 'authorized' | 'captured' | 'uncertain' | 'failed' | 'offline-approved' | 'expired' | 'caps-reached'}`;

const toneIcon: Record<SemanticRole, IconName> = {
  brand: 'info',
  success: 'check-circle',
  warning: 'alert',
  danger: 'x-circle',
  info: 'info',
  offline: 'wifi-off',
};

export interface StatusPillProps {
  readonly tone?: SemanticRole;
  readonly palette?: StatusPaletteKey;
  /** Visible text. Required: colour must never be the only signal. */
  readonly label: ReactNode;
  /** Override the default icon for the tone. */
  readonly icon?: IconName;
  readonly size?: 'sm' | 'md';
  readonly className?: string;
}

export function StatusPill({
  tone = 'info',
  palette,
  label,
  icon,
  size = 'md',
  className,
}: StatusPillProps) {
  return (
    <span
      className={cx('pos-pill', `pos-pill--${size}`, className)}
      data-tone={palette ? undefined : tone}
      data-palette={palette}
    >
      <Icon name={icon ?? toneIcon[tone]} />
      <span>{label}</span>
    </span>
  );
}

export interface BadgeProps {
  /** Count shown in the badge. Values above `max` render as "max+". */
  readonly count: number;
  readonly max?: number;
  readonly tone?: SemanticRole;
  /** Accessible description, e.g. "3 unsynced sales". */
  readonly label: string;
}

export function Badge({ count, max = 99, tone = 'danger', label }: BadgeProps) {
  const text = count > max ? `${max}+` : String(count);
  return (
    <span className="pos-badge" data-tone={tone} role="status" aria-label={label}>
      <span aria-hidden="true">{text}</span>
    </span>
  );
}
