import type { HTMLAttributes } from 'react';

import { cx } from '../../foundation/cx.js';
import { Icon, type IconName } from '../../foundation/Icon.js';
import { useUi } from '../../foundation/UiProvider.js';
import { StatusPill } from '../../primitives/StatusPill/StatusPill.js';

import { ageBucket, type AgeThresholds, type KdsAgeBucket } from './ageBucket.js';
import { TicketItem, type TicketItemProps } from './TicketItem.js';

export { ageBucket, defaultAgeThresholds } from './ageBucket.js';
export type { AgeThresholds, KdsAgeBucket } from './ageBucket.js';

export type TicketStatus = 'new' | 'in-progress' | 'ready' | 'fired';
/** The single primary action on a ticket. There is deliberately no "remove": a ticket can only be bumped. */
export type TicketAction = 'start' | 'ready' | 'bump';

/** What the primary action does for each status: new/fired tickets start, cooking ones become ready, ready ones are bumped. */
export function nextTicketAction(status: TicketStatus): TicketAction {
  switch (status) {
    case 'new':
    case 'fired':
      return 'start';
    case 'in-progress':
      return 'ready';
    case 'ready':
      return 'bump';
  }
}

const bucketIcon: Record<KdsAgeBucket, IconName> = {
  fresh: 'check',
  aging: 'clock',
  late: 'alert',
  critical: 'flag',
};

export interface TicketProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  /** Ticket number, shown as "#231". */
  readonly number: number | string;
  /** Source label: table ("T12"), takeaway ("TA"), delivery ("DEL"). */
  readonly source: string;
  readonly customer?: string;
  readonly guests?: number;
  /** Seconds since the ticket arrived; shown as mm:ss and bucketed into the age palette. */
  readonly ageSeconds: number;
  /** Per-station overrides; defaults 300 / 480 / 600 seconds. */
  readonly thresholds?: Partial<AgeThresholds>;
  readonly status: TicketStatus;
  /** e.g. "Course 2". */
  readonly courseLabel?: string;
  /** The order was modified after it reached the kitchen: shows an "UPDATED" badge. */
  readonly updated?: boolean;
  readonly items: readonly TicketItemProps[];
  readonly onAction?: (action: TicketAction) => void;
  /** Called for each item as it becomes voided. Sound is the app's job; the component only calls back and announces. */
  readonly onVoidedAnnounce?: (item: TicketItemProps) => void;
}

const statusPill = {
  new: { tone: 'brand', icon: 'bell', key: 'ticket.status.new' },
  'in-progress': { tone: 'info', icon: 'processing', key: 'ticket.status.inProgress' },
  ready: { tone: 'success', icon: 'check-circle', key: 'ticket.status.ready' },
  fired: { tone: 'warning', icon: 'send', key: 'ticket.status.fired' },
} as const;

const actionKey = {
  start: 'ticket.action.start',
  ready: 'ticket.action.ready',
  bump: 'ticket.action.bump',
} as const;

export function Ticket({
  number,
  source,
  customer,
  guests,
  ageSeconds,
  thresholds,
  status,
  courseLabel,
  updated = false,
  items,
  onAction,
  onVoidedAnnounce,
  className,
  ...rest
}: TicketProps) {
  const { t, format } = useUi();
  const bucket = ageBucket(ageSeconds, thresholds);
  const pill = statusPill[status];
  const action = nextTicketAction(status);
  const actionLabel = t(actionKey[action]);
  const statusLabel = t(pill.key);
  const meta = [
    customer,
    guests === undefined ? undefined : t('ticket.guests', { count: guests }),
  ].filter(Boolean);

  return (
    <article
      aria-label={t('ticket.label', { number, source, status: statusLabel })}
      {...rest}
      className={cx('pos-ticket', className)}
      data-palette={`kds-age-${bucket}`}
      data-bucket={bucket}
      data-status={status}
    >
      <header className="pos-ticket__header">
        <div className="pos-ticket__id">
          <span className="pos-ticket__number">#{number}</span>
          <span className="pos-ticket__source">{source}</span>
        </div>
        <div className="pos-ticket__age">
          <Icon name={bucketIcon[bucket]} className="pos-ticket__age-icon" />
          <span className="pos-num">
            <span className="pos-sr-only">{t('ticket.ageSr')} </span>
            {format.duration(ageSeconds)}
          </span>
        </div>
        <p className="pos-ticket__bucket">{t(`ticket.age.${bucket}`)}</p>
        {meta.length > 0 ? <p className="pos-ticket__meta">{meta.join(' · ')}</p> : null}
      </header>
      <div className="pos-ticket__strip">
        <StatusPill tone={pill.tone} icon={pill.icon} label={statusLabel} />
        {courseLabel ? <span className="pos-ticket__course">{courseLabel}</span> : null}
        {updated ? <StatusPill tone="warning" icon="edit" label={t('ticket.updated')} /> : null}
      </div>
      <ul className="pos-ticket__items" aria-label={t('ticket.items', { number })}>
        {items.map((item, index) => (
          <li key={item.id ?? index} className="pos-ticket__item">
            <TicketItem
              {...item}
              onVoidedAnnounce={() => {
                item.onVoidedAnnounce?.();
                onVoidedAnnounce?.(item);
              }}
            />
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="pos-ticket__action"
        data-action={action}
        aria-label={t('ticket.actionLabel', { action: actionLabel, number })}
        onClick={() => {
          onAction?.(action);
        }}
      >
        {actionLabel}
      </button>
    </article>
  );
}
