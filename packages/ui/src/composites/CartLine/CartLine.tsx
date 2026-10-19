import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';

import { cx } from '../../foundation/cx.js';
import { type IconName } from '../../foundation/Icon.js';
import { useUi } from '../../foundation/UiProvider.js';
import type { MessageKey } from '../../i18n/catalogs.generated.js';
import { StatusPill } from '../../primitives/StatusPill/StatusPill.js';
import type { SemanticRole } from '../../tokens.js';
import { QuantityStepper } from '../QuantityStepper/QuantityStepper.js';

export type CartLineState =
  'default' | 'selected' | 'voided' | 'unsent' | 'sent' | 'pending-approval';

export interface CartLineDiscount {
  readonly id?: string;
  /** Promotion or discount name, e.g. "PROMO 2-for-8". */
  readonly label: string;
  /** Discount magnitude in minor units. Always displayed as a negative amount. */
  readonly amountMinor: number;
}

export interface CartLineProps {
  /** Stable id of the line. Required inside a `CartLineList`. */
  readonly lineId?: string;
  readonly name: string;
  /** Variant and modifier text lines under the name. */
  readonly details?: readonly string[];
  readonly quantity: number;
  /** Decimals for weighed quantities (0.842 kg). */
  readonly quantityFractionDigits?: number;
  /** Unit shown after the quantity, e.g. "kg". */
  readonly unitLabel?: string;
  readonly unitPriceMinor: number;
  readonly lineTotalMinor: number;
  readonly discounts?: readonly CartLineDiscount[];
  readonly state?: CartLineState;
  /** Overrides `state === 'selected'`. Inside a `CartLineList` selection comes from the list. */
  readonly selected?: boolean;
  /** Shows an "Includes tax" note. */
  readonly taxInclusive?: boolean;
  /** Row activated by tap, Enter or Space. Makes a standalone row a toggle button. */
  readonly onSelect?: () => void;
  /**
   * Standalone rows only: renders a QuantityStepper beside the row. Inside a `CartLineList` the options are
   * ARIA-presentational, so put the stepper in the list's `selectedActions` strip instead.
   */
  readonly onQuantityChange?: (next: number) => void;
  readonly quantityMin?: number;
  readonly quantityMax?: number;
  readonly quantityStep?: number;
  /** Remove / void action slot. Standalone rows only (see `onQuantityChange`). */
  readonly actions?: ReactNode;
  readonly className?: string;
  readonly ref?: Ref<HTMLDivElement>;
}

interface CartListContextValue {
  readonly selectedId: string | null;
  readonly tabStopId: string | null;
  readonly select: (lineId: string) => void;
  readonly noteFocus: (lineId: string) => void;
  /** Moves focus for an arrow/Home/End key pressed on an option; returns whether it was handled. */
  readonly navigate: (from: HTMLElement, key: string) => boolean;
}

const CartListContext = createContext<CartListContextValue | null>(null);

const stateMeta: Partial<
  Record<CartLineState, { key: MessageKey; tone: SemanticRole; icon: IconName }>
> = {
  voided: { key: 'cartLine.state.voided', tone: 'danger', icon: 'ban' },
  unsent: { key: 'cartLine.state.unsent', tone: 'info', icon: 'clock' },
  sent: { key: 'cartLine.state.sent', tone: 'success', icon: 'check' },
  'pending-approval': { key: 'cartLine.state.pendingApproval', tone: 'warning', icon: 'lock' },
};

/**
 * One cart line. A line state is always shown as icon plus text; selection is `aria-selected` in a
 * `CartLineList` (listbox) or `aria-pressed` on a standalone row. Money is integer minor units.
 */
export function CartLine({
  lineId,
  name,
  details,
  quantity,
  quantityFractionDigits = 0,
  unitLabel,
  unitPriceMinor,
  lineTotalMinor,
  discounts,
  state = 'default',
  selected,
  taxInclusive = false,
  onSelect,
  onQuantityChange,
  quantityMin = 1,
  quantityMax,
  quantityStep,
  actions,
  className,
  ref,
}: CartLineProps) {
  const { t, format } = useUi();
  const list = useContext(CartListContext);
  const inList = list !== null && lineId !== undefined;
  const isSelected = inList ? list.selectedId === lineId : (selected ?? state === 'selected');
  const meta = stateMeta[state];

  const qtyText = format.number(quantity, {
    minimumFractionDigits: quantityFractionDigits,
    maximumFractionDigits: quantityFractionDigits,
  });
  const qtyDisplay = unitLabel ? `${qtyText} ${unitLabel}` : qtyText;
  const price = format.money(unitPriceMinor);

  const content = (
    <>
      <span className="pos-cart-line__row">
        <span className="pos-cart-line__name" title={name}>
          {name}
        </span>
        <span className="pos-cart-line__total pos-num">{format.money(lineTotalMinor)}</span>
      </span>
      {details?.map((line, index) => (
        <span key={`${index}-${line}`} className="pos-cart-line__detail">
          {line}
        </span>
      ))}
      <span className="pos-cart-line__row pos-cart-line__row--meta">
        <span className="pos-cart-line__qty pos-num">
          {unitLabel
            ? t('cartLine.qtyAtPrice', { qty: qtyDisplay, price })
            : t('cartLine.qtyTimesPrice', { qty: qtyDisplay, price })}
        </span>
        {meta ? (
          <StatusPill size="sm" tone={meta.tone} icon={meta.icon} label={t(meta.key)} />
        ) : null}
      </span>
      {discounts?.map((discount, index) => (
        <span
          key={discount.id ?? `${index}-${discount.label}`}
          className="pos-cart-line__row pos-cart-line__discount"
        >
          <span className="pos-cart-line__discount-label">{discount.label}</span>
          <span className="pos-num">{format.signedMoney(-Math.abs(discount.amountMinor))}</span>
        </span>
      ))}
      {taxInclusive ? (
        <span className="pos-cart-line__note">{t('cartLine.taxInclusive')}</span>
      ) : null}
    </>
  );

  const rootClass = cx(
    'pos-cart-line',
    isSelected && 'pos-cart-line--selected',
    `pos-cart-line--${state}`,
    className,
  );

  if (inList) {
    const activate = () => {
      list.select(lineId);
      onSelect?.();
    };
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      if (list.navigate(event.currentTarget, event.key)) {
        event.preventDefault();
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    };
    return (
      <div
        ref={ref}
        role="option"
        aria-selected={isSelected}
        tabIndex={list.tabStopId === lineId ? 0 : -1}
        data-line-id={lineId}
        data-state={state}
        className={cx(rootClass, 'pos-cart-line--interactive')}
        onClick={activate}
        onKeyDown={onKeyDown}
        onFocus={() => list.noteFocus(lineId)}
      >
        {content}
      </div>
    );
  }

  return (
    <div ref={ref} className={rootClass} data-state={state}>
      {onSelect ? (
        <button
          type="button"
          className="pos-cart-line__main pos-cart-line__main--button"
          aria-pressed={isSelected}
          onClick={onSelect}
        >
          {content}
        </button>
      ) : (
        <div className="pos-cart-line__main">{content}</div>
      )}
      {onQuantityChange || actions ? (
        <div className="pos-cart-line__controls">
          {onQuantityChange ? (
            <QuantityStepper
              value={quantity}
              onChange={onQuantityChange}
              min={quantityMin}
              {...(quantityMax !== undefined ? { max: quantityMax } : {})}
              {...(quantityStep !== undefined ? { step: quantityStep } : {})}
              fractionDigits={quantityFractionDigits}
              {...(unitLabel ? { unit: unitLabel } : {})}
              disabled={state === 'voided'}
              label={`${t('quantityStepper.label')}: ${name}`}
            />
          ) : null}
          {actions ? <div className="pos-cart-line__actions">{actions}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export interface CartLineListProps {
  /** `CartLine` elements, each with a unique `lineId`, as direct children. */
  readonly children?: ReactNode;
  readonly selectedId?: string | null;
  readonly defaultSelectedId?: string | null;
  readonly onSelectedIdChange?: (lineId: string) => void;
  /**
   * Action strip for the selected line (quantity stepper, discount, void). It renders after the listbox,
   * outside it, because ARIA options cannot contain interactive controls. Keep a destructive action
   * `--pos-touch-destructive-gap` away from the primary ones.
   */
  readonly selectedActions?: ReactNode;
  readonly 'aria-label'?: string;
  readonly className?: string;
  readonly ref?: Ref<HTMLDivElement>;
}

function lineIdOf(child: ReactNode): string | undefined {
  if (!isValidElement(child)) return undefined;
  const id = (child as ReactElement<{ lineId?: string }>).props.lineId;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Listbox of cart lines with roving focus: Tab enters on the selected line (or the first), Up/Down/Home/End
 * move focus, Enter or Space selects (docs/04-design-plan.md section 6, arrows in cart).
 */
export function CartLineList({
  children,
  selectedId: selectedProp,
  defaultSelectedId = null,
  onSelectedIdChange,
  selectedActions,
  'aria-label': ariaLabel,
  className,
  ref,
}: CartLineListProps) {
  const { t } = useUi();
  const [internalSelected, setInternalSelected] = useState<string | null>(defaultSelectedId);
  const [focusId, setFocusId] = useState<string | null>(null);
  const selectedId = selectedProp === undefined ? internalSelected : selectedProp;

  const ids = Children.toArray(children)
    .map(lineIdOf)
    .filter((id): id is string => id !== undefined);
  const tabStopId =
    (focusId && ids.includes(focusId) ? focusId : null) ??
    (selectedId && ids.includes(selectedId) ? selectedId : null) ??
    ids[0] ??
    null;

  const select = (lineId: string) => {
    if (selectedProp === undefined) setInternalSelected(lineId);
    onSelectedIdChange?.(lineId);
  };

  const navigate = (from: HTMLElement, key: string): boolean => {
    const list = from.closest('[role="listbox"]');
    if (!list) return false;
    const options = Array.from(list.querySelectorAll<HTMLElement>('[role="option"]'));
    const index = options.indexOf(from);
    if (index < 0) return false;
    let next: number;
    if (key === 'ArrowDown') next = Math.min(options.length - 1, index + 1);
    else if (key === 'ArrowUp') next = Math.max(0, index - 1);
    else if (key === 'Home') next = 0;
    else if (key === 'End') next = options.length - 1;
    else return false;
    options[next]?.focus();
    return true;
  };

  if (ids.length === 0 && Children.count(children) === 0) {
    return (
      <div ref={ref} className={cx('pos-cart-lines', className)}>
        <p className="pos-cart-lines__empty">{t('cartLine.empty')}</p>
      </div>
    );
  }

  return (
    <CartListContext.Provider
      value={{ selectedId, tabStopId, select, noteFocus: setFocusId, navigate }}
    >
      <div ref={ref} className={cx('pos-cart-lines', className)}>
        <div
          role="listbox"
          aria-label={ariaLabel ?? t('cartLine.list')}
          aria-orientation="vertical"
          className="pos-cart-lines__list"
        >
          {children}
        </div>
        {selectedActions ? (
          <div
            role="group"
            aria-label={t('cartLine.selectedActions')}
            className="pos-cart-lines__actions"
          >
            {selectedActions}
          </div>
        ) : null}
      </div>
    </CartListContext.Provider>
  );
}
