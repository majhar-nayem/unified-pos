import { useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { cx } from '../../foundation/cx.js';
import { Icon } from '../../foundation/Icon.js';
import { useUi } from '../../foundation/UiProvider.js';
import { useFocusTrap } from '../Dialog/useFocusTrap.js';
import { useScrollableFocus } from '../Dialog/useScrollableFocus.js';
import { useScrollLock } from '../Dialog/useScrollLock.js';

export type SheetSide = 'right' | 'left' | 'bottom';
export type SheetSize = 'sm' | 'md' | 'lg';

export interface SheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Sheet title; also the accessible name. */
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** Edge the sheet is anchored to: admin detail drawers use right/left, POS bottom sheets use bottom. */
  readonly side?: SheetSide;
  /** Width (right/left) or maximum height (bottom). */
  readonly size?: SheetSize;
  readonly footer?: ReactNode;
  readonly closeOnEsc?: boolean;
  readonly closeOnScrim?: boolean;
  readonly showCloseButton?: boolean;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly className?: string;
  readonly children?: ReactNode;
}

/** Edge-anchored modal panel with the same behaviour as Dialog (focus trap, restore, Esc, scrim, scroll lock). */
export function Sheet({
  open,
  onClose,
  title,
  description,
  side = 'right',
  size = 'md',
  footer,
  closeOnEsc = true,
  closeOnScrim = true,
  showCloseButton = true,
  initialFocusRef,
  className,
  children,
}: SheetProps) {
  const { t, portalContainer } = useUi();
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useFocusTrap({
    active: open,
    containerRef: panelRef,
    ...(initialFocusRef ? { initialFocusRef } : {}),
    onEscape: closeOnEsc ? onClose : undefined,
  });
  useScrollLock(open);
  const { attach: attachBody, tabIndex: bodyTabIndex } = useScrollableFocus();

  if (!open) return null;

  return createPortal(
    <div className="pos-sheet">
      <div
        className="pos-sheet__scrim"
        role="presentation"
        onClick={closeOnScrim ? onClose : undefined}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        data-side={side}
        className={cx('pos-sheet__panel', `pos-sheet__panel--${size}`, className)}
      >
        <div className="pos-sheet__header">
          <h2 id={titleId} className="pos-sheet__title">
            {title}
          </h2>
          {showCloseButton ? (
            <button
              type="button"
              className="pos-sheet__close"
              data-focus-skip=""
              aria-label={t('sheet.close')}
              onClick={onClose}
            >
              <Icon name="x" />
            </button>
          ) : null}
        </div>
        <div className="pos-sheet__body" ref={attachBody} tabIndex={bodyTabIndex}>
          {description ? (
            <p id={descriptionId} className="pos-sheet__description">
              {description}
            </p>
          ) : null}
          {children}
        </div>
        {footer ? <div className="pos-sheet__footer">{footer}</div> : null}
      </div>
    </div>,
    portalContainer ?? document.body,
  );
}
