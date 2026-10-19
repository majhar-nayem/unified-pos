import { useEffect, useRef, type RefObject } from 'react';

import { useUi } from '../../foundation/UiProvider.js';

const TABBABLE = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Tabbable descendants in DOM order (jsdom has no layout, so visibility is judged from attributes only). */
export function getTabbable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.hidden &&
      !element.closest('[hidden], [inert], [aria-hidden="true"]'),
  );
}

interface TrapEntry {
  readonly container: HTMLElement;
  readonly escape: () => void;
}

/** Open traps, topmost last. Only the topmost trap handles Tab and Escape, so dialogs can stack. */
const stack: TrapEntry[] = [];

export interface UseFocusTrapOptions {
  /** The trap is only in effect while true. */
  readonly active: boolean;
  /** The overlay panel that keeps focus. Give it `tabIndex={-1}` so it can hold focus when it has no tabbable content. */
  readonly containerRef: RefObject<HTMLElement | null>;
  /** Element to focus on open. Defaults to the first tabbable element, ignoring `[data-focus-skip]` ones (e.g. a close button). */
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  /** Return focus to the previously focused element on close. Default true. */
  readonly restoreFocus?: boolean;
  /**
   * Called on Escape when this is the topmost trap and no inner handler already called preventDefault
   * (so a combobox listbox inside a dialog can close itself first).
   */
  readonly onEscape?: () => void;
}

/**
 * Manual focus trap shared by Dialog and Sheet (no native <dialog>): moves focus in on open, wraps Tab and
 * Shift+Tab, handles Escape for the topmost overlay, and restores focus on close.
 */
export function useFocusTrap({
  active,
  containerRef,
  initialFocusRef,
  restoreFocus = true,
  onEscape,
}: UseFocusTrapOptions): void {
  // The UiProvider root is only known after its first commit, which moves portalled panels into it;
  // the trap re-binds when that happens so focus lands in the final DOM node.
  const { portalContainer } = useUi();
  const escapeRef = useRef(onEscape);
  const initialRef = useRef(initialFocusRef);
  useEffect(() => {
    escapeRef.current = onEscape;
    initialRef.current = initialFocusRef;
  });

  useEffect(() => {
    const found = containerRef.current;
    if (!active || !found) return undefined;
    const container: HTMLElement = found;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const entry: TrapEntry = { container, escape: () => escapeRef.current?.() };
    stack.push(entry);

    const tabbable = getTabbable(container);
    const preferred = tabbable.find((element) => !element.hasAttribute('data-focus-skip'));
    const target = initialRef.current?.current ?? preferred ?? tabbable[0] ?? container;
    target.focus({ preventScroll: true });

    function onKeyDown(event: KeyboardEvent) {
      if (stack[stack.length - 1] !== entry) return;
      if (event.key === 'Escape') {
        if (!event.defaultPrevented) {
          event.stopPropagation();
          entry.escape();
        }
        return;
      }
      if (event.key !== 'Tab') return;
      const items = getTabbable(container);
      const current = document.activeElement;
      if (items.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (!(current instanceof Node) || !container.contains(current)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (current === first || current === container)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const index = stack.indexOf(entry);
      if (index >= 0) stack.splice(index, 1);
      if (restoreFocus && previouslyFocused?.isConnected)
        previouslyFocused.focus({ preventScroll: true });
    };
  }, [active, containerRef, restoreFocus, portalContainer]);
}
