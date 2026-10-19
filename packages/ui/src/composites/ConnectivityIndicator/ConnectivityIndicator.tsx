import type { HTMLAttributes, Ref } from 'react';

import { cx } from '../../foundation/cx.js';
import { Icon, type IconName } from '../../foundation/Icon.js';
import { useUi } from '../../foundation/UiProvider.js';
import type { MessageKey } from '../../i18n/catalogs.generated.js';

export type ConnectivityStatus = 'online' | 'offline' | 'degraded' | 'syncing';

export interface ConnectivityIndicatorProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'children' | 'role'
> {
  readonly status: ConnectivityStatus;
  /** Icon + short text only. The full variant adds a one-line explanation. */
  readonly compact?: boolean;
  /** Time of the last successful sync; shown with `format.time`. */
  readonly lastSyncAt?: Date | number;
  readonly ref?: Ref<HTMLDivElement>;
}

const meta: Record<ConnectivityStatus, { icon: IconName; label: MessageKey; detail: MessageKey }> =
  {
    online: {
      icon: 'wifi',
      label: 'connectivityIndicator.online',
      detail: 'connectivityIndicator.onlineDetail',
    },
    offline: {
      icon: 'wifi-off',
      label: 'connectivityIndicator.offline',
      detail: 'connectivityIndicator.offlineDetail',
    },
    degraded: {
      icon: 'alert',
      label: 'connectivityIndicator.degraded',
      detail: 'connectivityIndicator.degradedDetail',
    },
    syncing: {
      icon: 'sync',
      label: 'connectivityIndicator.syncing',
      detail: 'connectivityIndicator.syncingDetail',
    },
  };

/**
 * Persistent connectivity status (never only a toast). A live `status` region with an icon and a text label;
 * the icon is static (no spinner) per the motion rules. Offline uses the dedicated offline role tokens.
 */
export function ConnectivityIndicator({
  status,
  compact = false,
  lastSyncAt,
  className,
  ref,
  title,
  ...rest
}: ConnectivityIndicatorProps) {
  const { t, format } = useUi();
  const { icon, label, detail } = meta[status];
  return (
    <div
      {...rest}
      ref={ref}
      role="status"
      title={title ?? (compact ? t(detail) : undefined)}
      data-status={status}
      className={cx(
        'pos-connectivity',
        compact ? 'pos-connectivity--compact' : 'pos-connectivity--full',
        className,
      )}
    >
      <Icon name={icon} />
      <span className="pos-connectivity__text">
        <span className="pos-connectivity__label">{t(label)}</span>
        {compact ? null : <span className="pos-connectivity__detail">{t(detail)}</span>}
        {!compact && lastSyncAt !== undefined ? (
          <span className="pos-connectivity__sync pos-num">
            {t('connectivityIndicator.lastSync', { time: format.time(lastSyncAt) })}
          </span>
        ) : null}
      </span>
    </div>
  );
}
