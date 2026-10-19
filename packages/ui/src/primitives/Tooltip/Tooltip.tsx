import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { cx } from '../../foundation/cx.js';
import { useUi } from '../../foundation/UiProvider.js';

export type TooltipPlacement = 'top' | 'bottom';

/** Props the tooltip reads from its trigger child. */
export interface TooltipTriggerProps {
  'aria-describedby'?: string;
}

export interface TooltipProps {
  /** Tooltip text. Keep it short and supplementary: it is not available on touch, so never put essential information only here. */
  readonly content: ReactNode;
  /** Preferred side. Defaults to `top`. */
  readonly placement?: TooltipPlacement;
  /** Hover delay before showing, in ms. Keyboard focus shows immediately. Default 100. */
  readonly delayMs?: number;
  /** Start open (stories, tests). */
  readonly defaultOpen?: boolean;
  readonly className?: string;
  /** Exactly one focusable element (button, link, input). A disabled button cannot be focused: wrap a focusable element instead. */
  readonly children: ReactElement<TooltipTriggerProps>;
}

const VIEWPORT_MARGIN = 8;
const HIDE_DELAY_MS = 80;

/**
 * Shows on hover and keyboard focus, hides on blur, mouse leave and Escape. The trigger gets
 * `aria-describedby` pointing at a `role="tooltip"` element portalled into the UI root.
 * The tooltip stays open while the pointer is over it (WCAG 1.4.13).
 */
export function Tooltip({
  content,
  placement = 'top',
  delayMs = 100,
  defaultOpen = false,
  className,
  children,
}: TooltipProps) {
  const { portalContainer } = useUi();
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearTimer = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const show = useCallback(
    (delay: number) => {
      clearTimer();
      if (delay <= 0) setOpen(true);
      else timer.current = setTimeout(() => setOpen(true), delay);
    },
    [clearTimer],
  );

  const hide = useCallback(
    (delay: number) => {
      clearTimer();
      if (delay <= 0) setOpen(false);
      else timer.current = setTimeout(() => setOpen(false), delay);
    },
    [clearTimer],
  );

  useEffect(() => clearTimer, [clearTimer]);

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const half = (tooltipRef.current?.offsetWidth ?? 0) / 2;
    const center = rect.left + rect.width / 2;
    const left = Math.min(
      Math.max(center, half + VIEWPORT_MARGIN),
      Math.max(window.innerWidth - half - VIEWPORT_MARGIN, half + VIEWPORT_MARGIN),
    );
    const top = placement === 'top' ? rect.top : rect.bottom;
    setPosition((current) =>
      current && current.left === left && current.top === top ? current : { left, top },
    );
  }, [placement]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      // Dismiss the tooltip only; a dialog containing the trigger must stay open.
      event.stopPropagation();
      clearTimer();
      setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, clearTimer]);

  const childProps = children.props;
  const trigger = cloneElement(children, {
    'aria-describedby': open
      ? [childProps['aria-describedby'], id].filter(Boolean).join(' ')
      : childProps['aria-describedby'],
  });

  return (
    <>
      <span
        ref={anchorRef}
        className="pos-tooltip-anchor"
        onMouseEnter={() => show(delayMs)}
        onMouseLeave={() => hide(HIDE_DELAY_MS)}
        onFocus={() => show(0)}
        onBlur={() => hide(0)}
      >
        {trigger}
      </span>
      {open
        ? createPortal(
            <div
              ref={tooltipRef}
              id={id}
              role="tooltip"
              data-placement={placement}
              className={cx('pos-tooltip', className)}
              style={
                position ? { left: position.left, top: position.top } : { visibility: 'hidden' }
              }
              onMouseEnter={clearTimer}
              onMouseLeave={() => hide(HIDE_DELAY_MS)}
            >
              {content}
            </div>,
            portalContainer ?? document.body,
          )
        : null}
    </>
  );
}
