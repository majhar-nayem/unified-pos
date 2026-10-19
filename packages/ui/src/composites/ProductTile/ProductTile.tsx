import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

import { cx } from '../../foundation/cx.js';
import { Icon } from '../../foundation/Icon.js';
import { useUi } from '../../foundation/UiProvider.js';
import { StatusPill } from '../../primitives/StatusPill/StatusPill.js';

export type ProductStock = 'available' | 'low' | 'out';

export interface ProductTileProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'onSelect' | 'children' | 'style' | 'value'
> {
  readonly productId: string;
  readonly name: string;
  readonly priceMinor: number;
  /** Appended to the price, e.g. "/kg" for weighed items. */
  readonly priceSuffix?: string;
  readonly imageSrc?: string;
  /** Alt text for the image. Empty (decorative) by default because the name is always shown. */
  readonly imageAlt?: string;
  readonly stock?: ProductStock;
  /** Units left; shown with the "low stock" state. */
  readonly stockCount?: number;
  /** 86'd / unavailable (for example sold out of kitchen stock): not selectable. */
  readonly unavailable?: boolean;
  /** Out-of-stock items stay selectable (negative stock allowed). Default: blocked. */
  readonly allowOutOfStock?: boolean;
  readonly ageRestricted?: boolean;
  /** Extra marker (promo, new, modifiers). */
  readonly badge?: ReactNode;
  readonly selected?: boolean;
  readonly onSelect?: (productId: string) => void;
  readonly ref?: Ref<HTMLButtonElement>;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => Array.from(w)[0] ?? '');
  return letters.join('').toUpperCase();
}

/**
 * Product button. At least 96 px square in the grid, never below the 48 px target. Stock and availability
 * are shown as icon plus text (never colour alone); blocked tiles use `aria-disabled` so they stay focusable
 * and announce why they cannot be added.
 */
export function ProductTile({
  productId,
  name,
  priceMinor,
  priceSuffix,
  imageSrc,
  imageAlt = '',
  stock = 'available',
  stockCount,
  unavailable = false,
  allowOutOfStock = false,
  ageRestricted = false,
  badge,
  selected = false,
  onSelect,
  className,
  onClick,
  ref,
  ...rest
}: ProductTileProps) {
  const { t, format } = useUi();
  const blocked = unavailable || (stock === 'out' && !allowOutOfStock);

  return (
    <button
      type="button"
      {...rest}
      ref={ref}
      aria-pressed={selected}
      aria-disabled={blocked || undefined}
      data-stock={stock}
      data-unavailable={unavailable || undefined}
      className={cx(
        'pos-product-tile',
        selected && 'pos-product-tile--selected',
        blocked && 'pos-product-tile--blocked',
        className,
      )}
      onClick={(event) => {
        if (blocked) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
        onSelect?.(productId);
      }}
    >
      <span
        className="pos-product-tile__media"
        aria-hidden={imageSrc && imageAlt ? undefined : true}
      >
        {imageSrc ? (
          <img className="pos-product-tile__image" src={imageSrc} alt={imageAlt} loading="lazy" />
        ) : (
          <span className="pos-product-tile__initials" aria-hidden="true">
            {initials(name)}
          </span>
        )}
      </span>
      <span className="pos-product-tile__name" title={name}>
        {name}
      </span>
      <span className="pos-product-tile__price pos-num">
        {format.money(priceMinor)}
        {priceSuffix ? <span className="pos-product-tile__suffix">{priceSuffix}</span> : null}
      </span>
      <span className="pos-product-tile__flags">
        {unavailable ? (
          <StatusPill size="sm" tone="offline" icon="ban" label={t('productTile.unavailable')} />
        ) : stock === 'out' ? (
          <StatusPill size="sm" tone="danger" icon="x-circle" label={t('productTile.stock.out')} />
        ) : stock === 'low' ? (
          <StatusPill
            size="sm"
            tone="warning"
            icon="alert"
            label={
              stockCount === undefined
                ? t('productTile.stock.low')
                : `${t('productTile.stock.low')}: ${t('productTile.stock.lowCount', { count: stockCount })}`
            }
          />
        ) : null}
        {ageRestricted ? (
          <span className="pos-product-tile__age">
            <Icon name="lock" />
            <span aria-hidden="true">{t('productTile.ageBadge')}</span>
            <span className="pos-sr-only">{t('productTile.ageRestricted')}</span>
          </span>
        ) : null}
        {badge ? <span className="pos-product-tile__badge">{badge}</span> : null}
      </span>
    </button>
  );
}
