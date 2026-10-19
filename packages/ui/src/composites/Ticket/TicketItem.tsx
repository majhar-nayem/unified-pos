import { useEffect, useRef } from 'react';

import { cx } from '../../foundation/cx.js';
import { Icon } from '../../foundation/Icon.js';
import { useUi } from '../../foundation/UiProvider.js';
import { StatusPill } from '../../primitives/StatusPill/StatusPill.js';

/** A modifier line. Use the object form to highlight a modifier that changed in an update. */
export type TicketModifier = string | { readonly label: string; readonly changed?: boolean };

export interface TicketItemProps {
  /** Stable identity for list keys; never rendered. */
  readonly id?: string;
  readonly quantity: number;
  readonly name: string;
  readonly modifiers?: readonly TicketModifier[];
  /** One or more allergens, rendered as a full-width high-contrast band: "ALLERGY: nut". */
  readonly allergy?: string | readonly string[];
  /** Struck through with a red "VOIDED {time}" line. Voided items stay on the ticket until it is bumped. */
  readonly voided?: boolean;
  /** When the item was voided; omit to show "VOIDED" alone. */
  readonly voidedAt?: Date | number;
  /** The item was added or changed by an update: highlighted with an "UPDATED" marker. */
  readonly changed?: boolean;
  readonly notes?: string;
  /**
   * Fired once when `voided` flips from false to true. The audible alert for a voided item is the app's job
   * (play the sound here); the component also announces the void through an assertive live region.
   */
  readonly onVoidedAnnounce?: () => void;
  readonly className?: string;
}

export function TicketItem({
  quantity,
  name,
  modifiers = [],
  allergy,
  voided = false,
  voidedAt,
  changed = false,
  notes,
  onVoidedAnnounce,
  className,
}: TicketItemProps) {
  const { t, format, locale } = useUi();

  const wasVoided = useRef(voided);
  useEffect(() => {
    if (voided && !wasVoided.current) onVoidedAnnounce?.();
    wasVoided.current = voided;
  }, [voided, onVoidedAnnounce]);

  const allergens =
    allergy === undefined ? [] : typeof allergy === 'string' ? [allergy] : [...allergy];
  const allergyText =
    allergens.length > 0
      ? new Intl.ListFormat(locale, { style: 'short', type: 'conjunction' }).format(allergens)
      : null;

  return (
    <div
      className={cx('pos-ticket-item', className)}
      data-voided={voided || undefined}
      data-changed={changed || undefined}
    >
      <span className="pos-ticket-item__qty pos-num">{quantity}</span>
      <div className="pos-ticket-item__body">
        <p className="pos-ticket-item__name">{name}</p>
        {modifiers.length > 0 ? (
          <ul className="pos-ticket-item__modifiers">
            {modifiers.map((modifier, index) => {
              const label = typeof modifier === 'string' ? modifier : modifier.label;
              const modifierChanged =
                typeof modifier === 'string' ? false : Boolean(modifier.changed);
              return (
                <li
                  key={`${index}-${label}`}
                  className="pos-ticket-item__modifier"
                  data-changed={modifierChanged || undefined}
                >
                  {label}
                  {modifierChanged ? (
                    <span className="pos-ticket-item__marker"> {t('ticketItem.updated')}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        {notes ? <p className="pos-ticket-item__notes">{notes}</p> : null}
        {voided ? (
          <p className="pos-ticket-item__voided">
            <Icon name="ban" />
            <span>
              {voidedAt === undefined
                ? t('ticketItem.voided')
                : t('ticketItem.voidedAt', { time: format.time(voidedAt) })}
            </span>
          </p>
        ) : null}
        {changed && !voided ? (
          <StatusPill tone="warning" icon="edit" size="sm" label={t('ticketItem.updated')} />
        ) : null}
      </div>
      {allergyText ? (
        <div className="pos-ticket-item__allergy">
          <Icon name="alert" />
          <span>{t('ticketItem.allergy', { allergens: allergyText })}</span>
        </div>
      ) : null}
      <span className="pos-sr-only" aria-live="assertive" aria-atomic="true">
        {voided ? t('ticketItem.voidedAnnounce', { quantity, name }) : null}
      </span>
    </div>
  );
}
