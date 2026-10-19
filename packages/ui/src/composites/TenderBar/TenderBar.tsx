import { useEffect, useId, useRef, type ReactNode, type Ref } from 'react';

import { cx } from '../../foundation/cx.js';
import { Icon } from '../../foundation/Icon.js';
import { useUi } from '../../foundation/UiProvider.js';
import { Button } from '../../primitives/Button/Button.js';

export type TenderKind = 'cash' | 'card' | 'other';

export interface TenderOption {
  /** Overrides the default label. Card keeps its mandatory offline wording unless this is set. */
  readonly label?: ReactNode;
  readonly disabled?: boolean;
  /** Short helper under the label (e.g. "Terminal not paired"). Shown as visible text. */
  readonly hint?: ReactNode;
  /** Key name shown as a keyboard hint and handled when `enableShortcuts` is set, e.g. "F1". */
  readonly shortcut?: string;
  /** Pre-computed amount shown on the button, e.g. rounded cash due. */
  readonly amountMinor?: number;
}

export interface OfflineCaps {
  /** The device has used up its offline card allowance (count or amount). */
  readonly reached: boolean;
  readonly remainingCount: number;
  readonly remainingAmountMinor: number;
}

export interface TenderBarProps {
  readonly totalDueMinor: number;
  readonly onTender: (kind: TenderKind) => void;
  readonly cash?: TenderOption;
  readonly card?: TenderOption;
  /** "Other / more" tenders (split, gift card, account). Omit to hide the button. */
  readonly other?: TenderOption | false;
  /** Defaults to true. When false the card button is relabelled for offline and capped by `offlineCaps`. */
  readonly online?: boolean;
  readonly offlineCaps?: OfflineCaps;
  /** Cash rounding delta shown beside the total, e.g. -1 for "Rounding -$0.01". */
  readonly roundingMinor?: number;
  /** Handle the tender shortcut keys on the document (ignored while typing in a field). */
  readonly enableShortcuts?: boolean;
  /**
   * Slot before the tenders for secondary actions (Void, Suspend). Anything destructive here stays at least
   * `--pos-touch-destructive-gap` (16 px) away from the tender buttons.
   */
  readonly leading?: ReactNode;
  readonly className?: string;
  readonly ref?: Ref<HTMLDivElement>;
}

const DEFAULT_SHORTCUTS: Record<TenderKind, string | undefined> = {
  cash: 'F1',
  card: 'F2',
  other: undefined,
};

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * Bottom tender bar: 72 px Cash / Card / Other buttons plus a total-due readout. Offline, the card button
 * says the terminal may approve offline up to the limit (never "card works offline"), and is disabled with a
 * visible reason once the offline caps are reached (design plan sections 1.6, 4.2, 5).
 */
export function TenderBar({
  totalDueMinor,
  onTender,
  cash,
  card,
  other,
  online = true,
  offlineCaps,
  roundingMinor,
  enableShortcuts = false,
  leading,
  className,
  ref,
}: TenderBarProps) {
  const { t, format } = useUi();
  const capsId = useId();

  const capsReached = !online && offlineCaps?.reached === true;
  const offline = !online;

  const options: Record<TenderKind, TenderOption | undefined> = {
    cash: { shortcut: DEFAULT_SHORTCUTS.cash, ...cash },
    card: { shortcut: DEFAULT_SHORTCUTS.card, ...card },
    other: other === false ? undefined : { shortcut: DEFAULT_SHORTCUTS.other, ...other },
  };

  const disabledOf = (kind: TenderKind): boolean =>
    options[kind]?.disabled === true || (kind === 'card' && capsReached);

  // Keep the latest state in a ref so the single document listener never goes stale.
  const latest = useRef({ options, disabledOf, onTender });
  useEffect(() => {
    latest.current = { options, disabledOf, onTender };
  });

  useEffect(() => {
    if (!enableShortcuts) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (isEditable(event.target)) return;
      const { options: opts, disabledOf: isDisabled, onTender: fire } = latest.current;
      const kinds: TenderKind[] = ['cash', 'card', 'other'];
      const kind = kinds.find((k) => {
        const key = opts[k]?.shortcut;
        return key !== undefined && key === event.key;
      });
      if (!kind) return;
      event.preventDefault();
      if (isDisabled(kind)) return;
      fire(kind);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enableShortcuts]);

  const renderButton = (
    kind: TenderKind,
    defaultLabel: ReactNode,
    describedBy?: string,
  ): ReactNode => {
    const option = options[kind];
    if (!option) return null;
    const hint =
      option.hint ??
      (kind === 'card' && offline && offlineCaps && !offlineCaps.reached
        ? t('tenderBar.offlineRemaining', {
            count: offlineCaps.remainingCount,
            amount: format.money(offlineCaps.remainingAmountMinor),
          })
        : undefined);
    return (
      <Button
        key={kind}
        size="tender"
        variant={kind === 'other' ? 'secondary' : 'primary'}
        className={cx('pos-tender-bar__button', `pos-tender-bar__button--${kind}`)}
        disabled={disabledOf(kind)}
        aria-keyshortcuts={enableShortcuts ? option.shortcut : undefined}
        aria-describedby={describedBy}
        iconStart={
          kind === 'cash' ? (
            <Icon name="cash" />
          ) : kind === 'card' ? (
            <Icon name="card" />
          ) : (
            <Icon name="more" />
          )
        }
        onClick={() => onTender(kind)}
      >
        <span className="pos-tender-bar__text">
          <span className="pos-tender-bar__label">{option.label ?? defaultLabel}</span>
          {option.amountMinor !== undefined ? (
            <span className="pos-tender-bar__amount pos-num">
              {format.money(option.amountMinor)}
            </span>
          ) : null}
          {hint ? <span className="pos-tender-bar__hint">{hint}</span> : null}
        </span>
        {option.shortcut ? (
          <kbd className="pos-tender-bar__key" aria-hidden="true">
            {option.shortcut}
          </kbd>
        ) : null}
      </Button>
    );
  };

  return (
    <div
      ref={ref}
      role="group"
      aria-label={t('tenderBar.region')}
      className={cx('pos-tender-bar', offline && 'pos-tender-bar--offline', className)}
    >
      {leading ? <div className="pos-tender-bar__leading">{leading}</div> : null}
      <div className="pos-tender-bar__due">
        <span className="pos-tender-bar__due-label">{t('tenderBar.totalDue')}</span>
        <span className="pos-tender-bar__due-amount pos-num">{format.money(totalDueMinor)}</span>
        {roundingMinor ? (
          <span className="pos-tender-bar__rounding pos-num">
            {t('tenderBar.rounding', { amount: format.signedMoney(roundingMinor) })}
          </span>
        ) : null}
      </div>
      <div className="pos-tender-bar__tenders">
        {renderButton('cash', t('tenderBar.cash'))}
        {renderButton(
          'card',
          offline ? t('tenderBar.cardOffline') : t('tenderBar.card'),
          capsReached ? capsId : undefined,
        )}
        {renderButton('other', t('tenderBar.other'))}
      </div>
      {capsReached ? (
        <p id={capsId} className="pos-tender-bar__reason">
          <Icon name="ban" />
          <span>{t('tenderBar.offlineCapsReached')}</span>
        </p>
      ) : null}
    </div>
  );
}
