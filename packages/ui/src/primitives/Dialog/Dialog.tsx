import { useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { cx } from '../../foundation/cx.js';
import { Icon } from '../../foundation/Icon.js';
import { useUi } from '../../foundation/UiProvider.js';

import { useFocusTrap } from './useFocusTrap.js';
import { useScrollableFocus } from './useScrollableFocus.js';
import { useScrollLock } from './useScrollLock.js';

export type DialogSize = 'sm' | 'md' | 'lg';

export interface DialogProps {
  readonly open: boolean;
  /** Called for Escape, scrim click and the close button (each can be disabled). */
  readonly onClose: () => void;
  /** Dialog title; also the accessible name (aria-labelledby). */
  readonly title: ReactNode;
  /** Optional supporting text, wired as aria-describedby (important for alertdialog). */
  readonly description?: ReactNode;
  /** `alertdialog` is for confirmations that need a response. */
  readonly role?: 'dialog' | 'alertdialog';
  readonly size?: DialogSize;
  /** Footer slot for actions. Keep >= 16px between destructive and primary actions (the footer gap already does). */
  readonly footer?: ReactNode;
  /** Escape closes. Default true. */
  readonly closeOnEsc?: boolean;
  /** Clicking the scrim closes. Default true for `dialog`, false for `alertdialog` (disable for destructive confirmations). */
  readonly closeOnScrim?: boolean;
  /** Header close button. Default true for `dialog`, false for `alertdialog` (confirmations use footer actions). */
  readonly showCloseButton?: boolean;
  /** Element focused when the dialog opens. Default: first tabbable element. */
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly className?: string;
  readonly children?: ReactNode;
}

/** Modal dialog: role=dialog, aria-modal, manual focus trap, focus restore, scroll lock, portalled into the UI root. */
export function Dialog({
  open,
  onClose,
  title,
  description,
  role = 'dialog',
  size = 'md',
  footer,
  closeOnEsc = true,
  closeOnScrim,
  showCloseButton,
  initialFocusRef,
  className,
  children,
}: DialogProps) {
  const { t, portalContainer } = useUi();
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const scrimCloses = closeOnScrim ?? role === 'dialog';
  const hasCloseButton = showCloseButton ?? role === 'dialog';

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
    <div className="pos-dialog">
      {/* Decorative layer: keyboard users close with Escape or the close button. */}
      <div
        className="pos-dialog__scrim"
        role="presentation"
        onClick={scrimCloses ? onClose : undefined}
      />
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cx('pos-dialog__panel', `pos-dialog__panel--${size}`, className)}
      >
        <div className="pos-dialog__header">
          <h2 id={titleId} className="pos-dialog__title">
            {title}
          </h2>
          {hasCloseButton ? (
            <button
              type="button"
              className="pos-dialog__close"
              data-focus-skip=""
              aria-label={t('dialog.close')}
              onClick={onClose}
            >
              <Icon name="x" />
            </button>
          ) : null}
        </div>
        <div className="pos-dialog__body" ref={attachBody} tabIndex={bodyTabIndex}>
          {description ? (
            <p id={descriptionId} className="pos-dialog__description">
              {description}
            </p>
          ) : null}
          {children}
        </div>
        {footer ? <div className="pos-dialog__footer">{footer}</div> : null}
      </div>
    </div>,
    portalContainer ?? document.body,
  );
}
