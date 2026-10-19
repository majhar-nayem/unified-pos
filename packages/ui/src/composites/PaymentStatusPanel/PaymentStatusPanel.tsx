import { useId, type HTMLAttributes, type ReactNode } from 'react';

import { cx } from '../../foundation/cx.js';
import { Icon, type IconName } from '../../foundation/Icon.js';
import { useUi } from '../../foundation/UiProvider.js';
import type { Translate } from '../../i18n/translate.js';
import { Button } from '../../primitives/Button/Button.js';
import type { StatusPaletteKey } from '../../primitives/StatusPill/StatusPill.js';

export { receiptPaymentLabel } from './receiptPaymentLabel.js';
export { useElapsed } from './useElapsed.js';

/**
 * Every state of the payment status panel (docs/04-design-plan.md 4.2). Money is integer minor units.
 *
 * Honesty rules (principle 6): green (`payment-captured`) is used only for money that has been captured
 * (`approved`, `forwarded-approved`). An offline approval is amber and says "will be submitted when online".
 */
export type PaymentPanelState =
  | {
      readonly kind: 'processing';
      /** e.g. "Tyro T2". */
      readonly terminalName?: string;
      /** e.g. "Reg 1". */
      readonly registerName?: string;
    }
  | { readonly kind: 'approved' }
  | { readonly kind: 'declined'; readonly reason: string }
  | { readonly kind: 'uncertain' }
  | { readonly kind: 'approved-offline' }
  | { readonly kind: 'forwarded-approved' }
  | { readonly kind: 'declined-after-reconnect' }
  | { readonly kind: 'expired' }
  | {
      readonly kind: 'caps-reached';
      /** Offline approvals taken so far. */
      readonly count: number;
      /** Offline ceiling reached, minor units. */
      readonly limitMinor: number;
    };

export type PaymentPanelStateKind = PaymentPanelState['kind'];

export const paymentPanelStateKinds = [
  'processing',
  'approved',
  'declined',
  'uncertain',
  'approved-offline',
  'forwarded-approved',
  'declined-after-reconnect',
  'expired',
  'caps-reached',
] as const satisfies readonly PaymentPanelStateKind[];

interface StateStyle {
  readonly palette: StatusPaletteKey;
  readonly icon: IconName;
  /** Assertive live region (money at risk); everything else is polite. */
  readonly assertive: boolean;
}

const stateStyle: Record<PaymentPanelStateKind, StateStyle> = {
  processing: { palette: 'payment-processing', icon: 'processing', assertive: false },
  approved: { palette: 'payment-captured', icon: 'check-circle', assertive: false },
  declined: { palette: 'payment-failed', icon: 'x-circle', assertive: true },
  uncertain: { palette: 'payment-uncertain', icon: 'alert', assertive: true },
  'approved-offline': { palette: 'payment-offline-approved', icon: 'wifi-off', assertive: false },
  'forwarded-approved': { palette: 'payment-captured', icon: 'check-circle', assertive: false },
  'declined-after-reconnect': { palette: 'payment-failed', icon: 'x-circle', assertive: true },
  expired: { palette: 'payment-expired', icon: 'hourglass', assertive: true },
  'caps-reached': { palette: 'payment-caps-reached', icon: 'ban', assertive: false },
};

/** The status palette a state uses (exported so queues and receipts stay consistent with the panel). */
export function paymentPanelPalette(kind: PaymentPanelStateKind): StatusPaletteKey {
  return stateStyle[kind].palette;
}

/** Card tender label. While offline it never promises acceptance: the terminal decides. */
export function cardTenderLabel(t: Translate, offline: boolean): string {
  return offline
    ? t('paymentStatusPanel.cardTender.offline')
    : t('paymentStatusPanel.cardTender.online');
}

export interface CardTenderLabelProps {
  /** True while the device is offline: label becomes "Card (terminal may approve offline, up to limit)". */
  readonly offline?: boolean;
}

export function CardTenderLabel({ offline = false }: CardTenderLabelProps) {
  const { t } = useUi();
  return <>{cardTenderLabel(t, offline)}</>;
}

export interface PaymentStatusPanelProps extends Omit<
  HTMLAttributes<HTMLElement>,
  'children' | 'title'
> {
  readonly state: PaymentPanelState;
  /** Tender name for the header ("CARD  32.86"). Defaults to the catalogued "Card". */
  readonly tenderLabel?: ReactNode;
  /** Tender amount in integer minor units. */
  readonly amountMinor: number;
  /** ISO 4217 code; defaults to the provider currency. */
  readonly currency?: string;
  /** Seconds the result has been unconfirmed (`uncertain`). Supplied by the app; see `useElapsed`. */
  readonly elapsedSeconds?: number;
  /** `uncertain` offers "Call manager" once `elapsedSeconds` reaches this. Default 60. */
  readonly callManagerAfterSeconds?: number;
  readonly onCancel?: () => void;
  readonly onRetry?: () => void;
  readonly onOtherTender?: () => void;
  readonly onCallManager?: () => void;
  readonly onCollectAgain?: () => void;
  readonly onContactCustomer?: () => void;
  /** Signals that a write-off is requested: the app must run the manager-approval flow. Nothing is written off here. */
  readonly onWriteOff?: () => void;
}

export function PaymentStatusPanel({
  state,
  tenderLabel,
  amountMinor,
  currency,
  elapsedSeconds = 0,
  callManagerAfterSeconds = 60,
  onCancel,
  onRetry,
  onOtherTender,
  onCallManager,
  onCollectAgain,
  onContactCustomer,
  onWriteOff,
  className,
  ...rest
}: PaymentStatusPanelProps) {
  const { t, format } = useUi();
  const messageId = useId();
  const style = stateStyle[state.kind];
  const amount = format.money(amountMinor, currency);
  const tender = tenderLabel ?? t('paymentStatusPanel.tender.card');

  let title: ReactNode = null;
  let body: ReactNode = null;
  let actions: ReactNode = null;

  switch (state.kind) {
    case 'processing': {
      const where = state.terminalName
        ? state.registerName
          ? t('paymentStatusPanel.processing.terminalRegister', {
              terminal: state.terminalName,
              register: state.registerName,
            })
          : t('paymentStatusPanel.processing.terminalOnly', { terminal: state.terminalName })
        : null;
      title = (
        <>
          {t('paymentStatusPanel.processing.title')}
          {where ? <span className="pos-payment-panel__where"> {where}</span> : null}
        </>
      );
      body = t('paymentStatusPanel.processing.body');
      actions = (
        <Button variant="secondary" onClick={onCancel}>
          {t('paymentStatusPanel.processing.cancel')}
        </Button>
      );
      break;
    }
    case 'approved':
      title = t('paymentStatusPanel.approved.title');
      body = t('paymentStatusPanel.approved.body', { amount });
      break;
    case 'declined':
      title = t('paymentStatusPanel.declined.title');
      body = t('paymentStatusPanel.declined.reason', { reason: state.reason });
      actions = (
        <>
          <Button variant="primary" onClick={onRetry}>
            {t('paymentStatusPanel.declined.retry')}
          </Button>
          <Button variant="secondary" onClick={onOtherTender}>
            {t('paymentStatusPanel.declined.otherTender')}
          </Button>
        </>
      );
      break;
    case 'uncertain': {
      const escalated = elapsedSeconds >= callManagerAfterSeconds;
      title = t('paymentStatusPanel.uncertain.title');
      body = (
        <>
          <span className="pos-payment-panel__line">{t('paymentStatusPanel.uncertain.body')}</span>
          <span className="pos-payment-panel__line pos-num">
            {t('paymentStatusPanel.uncertain.elapsed', {
              elapsed: format.duration(elapsedSeconds),
            })}
          </span>
          {escalated ? (
            <span className="pos-payment-panel__line">
              {t('paymentStatusPanel.uncertain.escalated')}
            </span>
          ) : null}
        </>
      );
      if (escalated) {
        actions = (
          <Button variant="primary" onClick={onCallManager}>
            {t('paymentStatusPanel.uncertain.callManager')}
          </Button>
        );
      }
      break;
    }
    case 'approved-offline':
      title = t('paymentStatusPanel.approvedOffline.title');
      body = t('paymentStatusPanel.approvedOffline.body');
      break;
    case 'forwarded-approved':
      title = t('paymentStatusPanel.forwardedApproved.title');
      body = t('paymentStatusPanel.forwardedApproved.body');
      break;
    case 'declined-after-reconnect':
    case 'expired': {
      title =
        state.kind === 'expired'
          ? t('paymentStatusPanel.expired.title')
          : t('paymentStatusPanel.declinedAfterReconnect.title');
      body =
        state.kind === 'expired'
          ? t('paymentStatusPanel.expired.body', { amount })
          : t('paymentStatusPanel.declinedAfterReconnect.body', { amount });
      actions = (
        <>
          <Button variant="primary" onClick={onCollectAgain}>
            {t('paymentStatusPanel.recovery.collectAgain')}
          </Button>
          <Button variant="secondary" onClick={onContactCustomer}>
            {t('paymentStatusPanel.recovery.contactCustomer')}
          </Button>
          <Button variant="danger" iconStart={<Icon name="lock" />} onClick={onWriteOff}>
            {t('paymentStatusPanel.recovery.writeOff')}{' '}
            <span className="pos-sr-only">
              ({t('paymentStatusPanel.recovery.writeOffApproval')})
            </span>
          </Button>
        </>
      );
      break;
    }
    case 'caps-reached':
      title = t('paymentStatusPanel.capsReached.title', {
        count: state.count,
        amount: format.money(state.limitMinor, currency),
      });
      actions = (
        <Button
          variant="secondary"
          size="tender"
          iconStart={<Icon name="card" />}
          disabled
          aria-describedby={messageId}
        >
          {tender}
        </Button>
      );
      break;
  }

  const recovery = state.kind === 'declined-after-reconnect' || state.kind === 'expired';

  return (
    <section
      aria-label={t('paymentStatusPanel.region')}
      {...rest}
      className={cx('pos-payment-panel', className)}
      data-palette={style.palette}
      data-state={state.kind}
    >
      <header className="pos-payment-panel__header">
        <span className="pos-payment-panel__tender">{tender}</span>
        <span className="pos-payment-panel__amount pos-num">{amount}</span>
      </header>
      <div
        className="pos-payment-panel__status"
        role={style.assertive ? 'alert' : 'status'}
        aria-live={style.assertive ? 'assertive' : 'polite'}
        aria-atomic="true"
      >
        <Icon name={style.icon} className="pos-payment-panel__icon" />
        <div className="pos-payment-panel__text">
          <p className="pos-payment-panel__title" id={messageId}>
            {title}
          </p>
          {body ? <p className="pos-payment-panel__body">{body}</p> : null}
        </div>
      </div>
      {actions ? <div className="pos-payment-panel__actions">{actions}</div> : null}
      {recovery ? (
        <p className="pos-payment-panel__note">{t('paymentStatusPanel.recovery.approvalNote')}</p>
      ) : null}
    </section>
  );
}
