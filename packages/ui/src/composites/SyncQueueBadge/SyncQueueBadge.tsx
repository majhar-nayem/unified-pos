import type { Ref } from 'react';

import { cx } from '../../foundation/cx.js';
import { useUi } from '../../foundation/UiProvider.js';
import { Badge, StatusPill } from '../../primitives/StatusPill/StatusPill.js';

export interface OfflinePayments {
  /** Card payments approved offline by the terminal and not yet submitted to the provider. */
  readonly count: number;
  /** Seconds left until the soonest provider submission window closes. */
  readonly soonestExpirySeconds: number;
}

export interface SyncQueueBadgeProps {
  /** Sales recorded on this device and not yet synced. */
  readonly pendingCount: number;
  /** Age in seconds of the oldest unsynced sale. */
  readonly oldestAgeSeconds?: number;
  /** Sales the server rejected. Shows "Needs attention". */
  readonly error?: { readonly rejectedCount: number };
  /** Unsynced offline card payments; the expiry countdown is shown while offline. Pure props: no timers here. */
  readonly offlinePayments?: OfflinePayments;
  /** Defaults to true. The expiry countdown is only shown while offline. */
  readonly online?: boolean;
  /** Render nothing (instead of "All synced") when there is nothing to show. */
  readonly hideWhenSynced?: boolean;
  readonly className?: string;
  readonly ref?: Ref<HTMLDivElement>;
}

/** Under one hour left on an offline card payment turns amber. */
const AMBER_BELOW_SECONDS = 60 * 60;

/**
 * Unsynced-work indicator: pending sales, rejected sales ("Needs attention") and offline card payments with an
 * expiry countdown. Every state is a count plus text, with an accessible description such as
 * "3 sales waiting to sync".
 */
export function SyncQueueBadge({
  pendingCount,
  oldestAgeSeconds,
  error,
  offlinePayments,
  online = true,
  hideWhenSynced = false,
  className,
  ref,
}: SyncQueueBadgeProps) {
  const { t, format } = useUi();
  const rejected = error?.rejectedCount ?? 0;
  const hasError = error !== undefined && rejected > 0;
  const hasPending = pendingCount > 0;
  const paymentCount = offlinePayments?.count ?? 0;
  const hasPayments = offlinePayments !== undefined && paymentCount > 0;

  if (!hasError && !hasPending && !hasPayments) {
    if (hideWhenSynced) return null;
    return (
      <div ref={ref} className={cx('pos-sync-queue', className)} data-state="synced">
        <StatusPill tone="success" icon="check-circle" label={t('syncQueueBadge.allSynced')} />
      </div>
    );
  }

  const pendingText = hasPending
    ? [
        t('syncQueueBadge.pending', { count: pendingCount }),
        oldestAgeSeconds !== undefined
          ? t('syncQueueBadge.oldest', { age: format.duration(oldestAgeSeconds) })
          : undefined,
      ]
        .filter(Boolean)
        .join(', ')
    : undefined;
  const rejectedText = hasError
    ? `${t('syncQueueBadge.rejected', { count: rejected })}: ${t('syncQueueBadge.needsAttention')}`
    : undefined;

  const paymentPill = (() => {
    if (!hasPayments || !offlinePayments) return null;
    if (online) {
      return (
        <StatusPill
          tone="info"
          icon="sync"
          label={t('syncQueueBadge.offlinePaymentsOnline', { count: paymentCount })}
        />
      );
    }
    const left = offlinePayments.soonestExpirySeconds;
    if (left <= 0) {
      return (
        <StatusPill
          tone="danger"
          icon="hourglass"
          label={t('syncQueueBadge.offlinePaymentsExpired', { count: paymentCount })}
        />
      );
    }
    return (
      <StatusPill
        tone={left < AMBER_BELOW_SECONDS ? 'warning' : 'offline'}
        icon="hourglass"
        label={t('syncQueueBadge.offlinePaymentsExpiry', {
          count: paymentCount,
          time: format.duration(left),
        })}
      />
    );
  })();

  return (
    <div
      ref={ref}
      className={cx('pos-sync-queue', className)}
      data-state={hasError ? 'error' : hasPending ? 'pending' : 'payments'}
    >
      {hasError && rejectedText ? (
        <div className="pos-sync-queue__item pos-sync-queue__item--error">
          <Badge count={rejected} tone="danger" label={rejectedText} />
          <span className="pos-sync-queue__text" aria-hidden="true">
            <strong>{t('syncQueueBadge.needsAttention')}</strong>
            <span>{t('syncQueueBadge.rejected', { count: rejected })}</span>
          </span>
        </div>
      ) : null}
      {hasPending && pendingText ? (
        <div className="pos-sync-queue__item">
          <Badge count={pendingCount} tone={hasError ? 'warning' : 'info'} label={pendingText} />
          <span className="pos-sync-queue__text pos-num" aria-hidden="true">
            {pendingText}
          </span>
        </div>
      ) : null}
      {paymentPill ? <div className="pos-sync-queue__item pos-num">{paymentPill}</div> : null}
    </div>
  );
}
