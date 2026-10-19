import type { HTMLAttributes, ReactNode, Ref } from 'react';

import { cx } from '../../foundation/cx.js';
import { Icon, type IconName } from '../../foundation/Icon.js';
import { useUi } from '../../foundation/UiProvider.js';
import type { MessageValues } from '../../i18n/translate.js';

export type BannerTone = 'info' | 'warning' | 'danger' | 'success' | 'offline';
/** Ready-made connectivity banners (docs/04-design-plan.md section 4.5). Copy comes from the catalog, so tenants can override it. */
export type BannerVariant = 'offline' | 'degraded' | 'cloudRouting' | 'warning';

const toneIcon: Record<BannerTone, IconName> = {
  info: 'info',
  warning: 'alert',
  danger: 'x-circle',
  success: 'check-circle',
  offline: 'wifi-off',
};

const variantConfig = {
  // Red: "Offline — tickets from this device only" (profile B).
  offline: { tone: 'danger', icon: 'wifi-off', key: 'banner.offline' },
  // Amber: "KDS hub degraded — printing fallback active at {station}".
  degraded: { tone: 'warning', icon: 'printer', key: 'banner.degraded' },
  // Amber: "Cloud routing — hub unreachable".
  cloudRouting: { tone: 'warning', icon: 'cloud-off', key: 'banner.cloudRouting' },
  warning: { tone: 'warning', icon: 'alert', key: 'banner.warning' },
} as const satisfies Record<
  BannerVariant,
  {
    tone: BannerTone;
    icon: IconName;
    key: 'banner.offline' | 'banner.degraded' | 'banner.cloudRouting' | 'banner.warning';
  }
>;

export interface BannerProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Colour role. Defaults to `info`, or the variant's tone. */
  readonly tone?: BannerTone;
  /** Connectivity preset: sets tone, icon and default copy. */
  readonly variant?: BannerVariant;
  /** Station name for the `degraded` variant copy, e.g. "Grill". */
  readonly station?: string;
  /** Override icon. Banners always show an icon plus text, never colour alone. */
  readonly icon?: IconName;
  /** Replaces the default copy. Required when no `variant` is given. */
  readonly children?: ReactNode;
  /** Optional action, typically a small secondary Button ("Retry", "View queue"). */
  readonly action?: ReactNode;
  /** Shows a dismiss button that calls this. */
  readonly onDismiss?: () => void;
  readonly ref?: Ref<HTMLDivElement>;
}

/**
 * Inline banner. `role="status"` (polite) for most tones and `role="alert"` for `danger`; connectivity
 * variants are persistent state rather than an event, so they stay `status` unless you pass `role`.
 */
export function Banner({
  tone,
  variant,
  station,
  icon,
  children,
  action,
  onDismiss,
  className,
  role,
  ref,
  ...rest
}: BannerProps) {
  const { t } = useUi();
  const preset = variant ? variantConfig[variant] : undefined;
  const resolvedTone: BannerTone = tone ?? preset?.tone ?? 'info';
  const values: MessageValues = { station: station ?? '' };
  const content = children ?? (preset ? t(preset.key as never, values) : null);
  const resolvedRole = role ?? (!variant && resolvedTone === 'danger' ? 'alert' : 'status');
  return (
    <div
      {...rest}
      ref={ref}
      role={resolvedRole}
      data-tone={resolvedTone}
      data-variant={variant}
      className={cx('pos-banner', className)}
    >
      <Icon name={icon ?? preset?.icon ?? toneIcon[resolvedTone]} className="pos-banner__icon" />
      <div className="pos-banner__content">{content}</div>
      {action ? <div className="pos-banner__action">{action}</div> : null}
      {onDismiss ? (
        <button
          type="button"
          className="pos-banner__dismiss"
          aria-label={t('banner.dismiss')}
          onClick={onDismiss}
        >
          <Icon name="x" />
        </button>
      ) : null}
    </div>
  );
}
