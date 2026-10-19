import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { cx } from '../../foundation/cx.js';
import { useUi } from '../../foundation/UiProvider.js';

export interface TabItem {
  /** Unique value; also used to build element ids. */
  readonly value: string;
  readonly label: ReactNode;
  /** Optional count badge (e.g. open orders). Announced as "N items" through t(). */
  readonly count?: number;
  readonly disabled?: boolean;
  /** Panel content, rendered only while the tab is selected. */
  readonly content?: ReactNode;
}

export interface TabsProps {
  readonly items: readonly TabItem[];
  /** Controlled selected value. */
  readonly value?: string;
  /** Uncontrolled initial value. Defaults to the first enabled tab. */
  readonly defaultValue?: string;
  readonly onValueChange?: (value: string) => void;
  /** Accessible name for the tab list (required: there is no visible heading to point at). */
  readonly 'aria-label'?: string;
  readonly 'aria-labelledby'?: string;
  readonly className?: string;
}

function isRtl(element: HTMLElement): boolean {
  return getComputedStyle(element).direction === 'rtl';
}

/**
 * WAI-ARIA tabs with automatic activation: arrow keys move focus and select, Home/End jump to the ends,
 * and only the selected tab is in the Tab order (roving tabindex).
 */
export function Tabs({
  items,
  value,
  defaultValue,
  onValueChange,
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: TabsProps) {
  const { t } = useUi();
  const baseId = useId();
  const firstEnabled = items.find((item) => !item.disabled)?.value;
  const [internal, setInternal] = useState(defaultValue ?? firstEnabled);
  const selected = value ?? internal;
  const listRef = useRef<HTMLDivElement>(null);

  const tabId = (v: string) => `${baseId}-tab-${v}`;
  const panelId = (v: string) => `${baseId}-panel-${v}`;

  function select(next: string) {
    if (value === undefined) setInternal(next);
    if (next !== selected) onValueChange?.(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const enabled = items.filter((item) => !item.disabled);
    if (enabled.length === 0) return;
    const currentIndex = enabled.findIndex(
      (item) => tabId(item.value) === (event.target as HTMLElement).id,
    );
    if (currentIndex < 0) return;
    const rtl = listRef.current ? isRtl(listRef.current) : false;
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const backward = rtl ? 'ArrowRight' : 'ArrowLeft';
    let next: number | undefined;
    if (event.key === forward) next = (currentIndex + 1) % enabled.length;
    else if (event.key === backward) next = (currentIndex - 1 + enabled.length) % enabled.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = enabled.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    const target = enabled[next]!;
    document.getElementById(tabId(target.value))?.focus();
    select(target.value);
  }

  const activeItem = items.find((item) => item.value === selected);

  return (
    <div className={cx('pos-tabs', className)}>
      {/* Arrow-key handling is delegated from the tab buttons; the list itself is not interactive. */}
      <div
        ref={listRef}
        role="tablist"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className="pos-tabs__list"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {items.map((item) => {
          const isSelected = item.value === selected;
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              id={tabId(item.value)}
              className="pos-tabs__tab"
              aria-selected={isSelected}
              aria-controls={isSelected ? panelId(item.value) : undefined}
              tabIndex={isSelected ? 0 : -1}
              disabled={item.disabled}
              onClick={() => select(item.value)}
            >
              <span className="pos-tabs__label">{item.label}</span>
              {item.count !== undefined ? (
                <>
                  <span className="pos-tabs__count" aria-hidden="true">
                    {item.count}
                  </span>{' '}
                  <span className="pos-sr-only">{t('tabs.count', { count: item.count })}</span>
                </>
              ) : null}
            </button>
          );
        })}
      </div>
      {activeItem ? (
        <div
          role="tabpanel"
          id={panelId(activeItem.value)}
          aria-labelledby={tabId(activeItem.value)}
          tabIndex={0}
          className="pos-tabs__panel"
        >
          {activeItem.content}
        </div>
      ) : null}
    </div>
  );
}
