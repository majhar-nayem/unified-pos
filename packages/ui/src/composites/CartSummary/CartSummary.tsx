import type { ReactNode, Ref } from 'react';

import { cx } from '../../foundation/cx.js';
import { useUi } from '../../foundation/UiProvider.js';

export interface CartSummaryProps {
  readonly subtotalMinor: number;
  /** Discount magnitude; shown as a negative amount. Hidden when 0 or omitted. */
  readonly discountMinor?: number;
  readonly taxMinor?: number;
  /** `inclusive` (AU GST): tax is already inside the prices. `exclusive`: tax is added to the total. */
  readonly tax?: 'inclusive' | 'exclusive';
  /** Tax name, e.g. "GST". Defaults to the catalog's `cartSummary.taxName`. */
  readonly taxName?: string;
  readonly tipMinor?: number;
  readonly serviceChargeMinor?: number;
  /** Cash rounding adjustment (signed, e.g. -1). Shown only when non-zero. */
  readonly roundingMinor?: number;
  /** Grand total in minor units. */
  readonly totalMinor: number;
  readonly itemCount?: number;
  readonly paidMinor?: number;
  readonly amountDueMinor?: number;
  readonly changeMinor?: number;
  readonly className?: string;
  readonly ref?: Ref<HTMLElement>;
}

interface RowProps {
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly variant?: 'total' | 'emphasis';
  readonly tone?: 'discount';
}

function Row({ label, value, variant, tone }: RowProps) {
  return (
    <div
      className={cx(
        'pos-cart-summary__row',
        variant && `pos-cart-summary__row--${variant}`,
        tone && `pos-cart-summary__row--${tone}`,
      )}
    >
      <dt className="pos-cart-summary__label">{label}</dt>
      <dd className="pos-cart-summary__value pos-num">{value}</dd>
    </div>
  );
}

/**
 * Order totals. All amounts are integer minor units formatted through `format.money`. A visually hidden
 * polite status announces the grand total whenever it changes (POS announces totals, design plan section 6).
 */
export function CartSummary({
  subtotalMinor,
  discountMinor,
  taxMinor,
  tax = 'inclusive',
  taxName,
  tipMinor,
  serviceChargeMinor,
  roundingMinor,
  totalMinor,
  itemCount,
  paidMinor,
  amountDueMinor,
  changeMinor,
  className,
  ref,
}: CartSummaryProps) {
  const { t, format } = useUi();
  const name = taxName ?? t('cartSummary.taxName');
  const taxLabel =
    tax === 'inclusive'
      ? t('cartSummary.taxInclusive', { name })
      : t('cartSummary.taxExclusive', { name });
  const total = format.money(totalMinor);

  return (
    <section
      ref={ref}
      aria-label={t('cartSummary.region')}
      className={cx('pos-cart-summary', className)}
    >
      {itemCount !== undefined ? (
        <p className="pos-cart-summary__count">{t('cartSummary.items', { count: itemCount })}</p>
      ) : null}
      <dl className="pos-cart-summary__list">
        <Row label={t('cartSummary.subtotal')} value={format.money(subtotalMinor)} />
        {discountMinor ? (
          <Row
            label={t('cartSummary.discounts')}
            value={format.signedMoney(-Math.abs(discountMinor))}
            tone="discount"
          />
        ) : null}
        {serviceChargeMinor ? (
          <Row label={t('cartSummary.service')} value={format.money(serviceChargeMinor)} />
        ) : null}
        {taxMinor !== undefined ? <Row label={taxLabel} value={format.money(taxMinor)} /> : null}
        {tipMinor ? <Row label={t('cartSummary.tip')} value={format.money(tipMinor)} /> : null}
        {roundingMinor ? (
          <Row label={t('cartSummary.rounding')} value={format.signedMoney(roundingMinor)} />
        ) : null}
        <Row label={t('cartSummary.total')} value={total} variant="total" />
        {paidMinor !== undefined ? (
          <Row label={t('cartSummary.paid')} value={format.money(paidMinor)} variant="emphasis" />
        ) : null}
        {amountDueMinor !== undefined ? (
          <Row
            label={t('cartSummary.amountDue')}
            value={format.money(amountDueMinor)}
            variant="emphasis"
          />
        ) : null}
        {changeMinor !== undefined ? (
          <Row
            label={t('cartSummary.change')}
            value={format.money(changeMinor)}
            variant="emphasis"
          />
        ) : null}
      </dl>
      <p role="status" aria-live="polite" aria-atomic="true" className="pos-sr-only">
        {t('cartSummary.announce', { total, count: itemCount ?? 0 })}
      </p>
    </section>
  );
}
