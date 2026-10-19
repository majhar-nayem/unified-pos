import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { cx } from '../../foundation/cx.js';
import { Icon, type IconName } from '../../foundation/Icon.js';
import { useUi } from '../../foundation/UiProvider.js';
import type { SemanticRole } from '../../tokens.js';

export type ToastTone = Exclude<SemanticRole, 'brand'>;
export type ToastPlacement = 'bottom-end' | 'bottom-center' | 'top-end';

export interface ToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface ToastOptions {
  /** Defaults to `info`. `danger` is announced assertively; everything else politely. */
  readonly tone?: ToastTone;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ToastAction;
  /**
   * Auto-dismiss delay in ms. Default 5000 (8000 for `danger`). `0` keeps the toast until dismissed.
   * Timers pause while the toast is hovered or has keyboard focus.
   */
  readonly durationMs?: number;
}

export interface ToastApi {
  /** Shows a toast and returns its id. */
  readonly toast: (options: ToastOptions) => string;
  readonly dismiss: (id: string) => void;
  readonly dismissAll: () => void;
}

interface ToastEntry extends ToastOptions {
  readonly id: string;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Toasts are transient confirmations. Design rule (docs/04-design-plan.md section 3): state is never ONLY a
 * toast. A payment result, a failed sync or an offline transition also has to be visible in the page
 * (StatusPill, Banner, list state) because a toast can disappear before it is read.
 */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>.');
  return api;
}

const toneIcon: Record<ToastTone, IconName> = {
  success: 'check-circle',
  warning: 'alert',
  danger: 'x-circle',
  info: 'info',
  offline: 'wifi-off',
};

const DEFAULT_DURATION_MS = 5000;
const DANGER_DURATION_MS = 8000;

export interface ToastProviderProps {
  readonly placement?: ToastPlacement;
  /** Most toasts shown at once; older ones are dropped first. Default 4. */
  readonly maxVisible?: number;
  readonly children: ReactNode;
}

export function ToastProvider({
  placement = 'bottom-end',
  maxVisible = 4,
  children,
}: ToastProviderProps) {
  const { t, portalContainer } = useUi();
  const [entries, setEntries] = useState<readonly ToastEntry[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    setEntries((current) => current.filter((entry) => entry.id !== id));
  }, []);
  const dismissAll = useCallback(() => setEntries([]), []);
  const toast = useCallback(
    (options: ToastOptions) => {
      counter.current += 1;
      const id = `pos-toast-${counter.current}`;
      setEntries((current) => [...current, { ...options, id }].slice(-maxVisible));
      return id;
    },
    [maxVisible],
  );
  const api = useMemo<ToastApi>(
    () => ({ toast, dismiss, dismissAll }),
    [toast, dismiss, dismissAll],
  );

  const polite = entries.filter((entry) => entry.tone !== 'danger');
  const assertive = entries.filter((entry) => entry.tone === 'danger');

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div
          className="pos-toast-region"
          data-placement={placement}
          role="region"
          aria-label={t('toast.region')}
        >
          {/* Live regions exist before their content so assistive tech announces additions. */}
          <div
            className="pos-toast-list"
            role="status"
            aria-live="polite"
            aria-relevant="additions text"
          >
            {polite.map((entry) => (
              <ToastItem key={entry.id} entry={entry} onDismiss={dismiss} />
            ))}
          </div>
          <div className="pos-toast-list" role="alert" aria-live="assertive">
            {assertive.map((entry) => (
              <ToastItem key={entry.id} entry={entry} onDismiss={dismiss} />
            ))}
          </div>
        </div>,
        portalContainer ?? document.body,
      )}
    </ToastContext.Provider>
  );
}

function ToastItem({ entry, onDismiss }: { entry: ToastEntry; onDismiss: (id: string) => void }) {
  const { t } = useUi();
  const tone = entry.tone ?? 'info';
  const duration =
    entry.durationMs ?? (tone === 'danger' ? DANGER_DURATION_MS : DEFAULT_DURATION_MS);
  const [paused, setPaused] = useState(false);
  const remaining = useRef(duration);
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  useEffect(() => {
    if (paused || duration <= 0) return undefined;
    const startedAt = Date.now();
    const handle = setTimeout(() => dismissRef.current(entry.id), remaining.current);
    return () => {
      clearTimeout(handle);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt));
    };
  }, [paused, duration, entry.id]);

  return (
    <div
      className={cx('pos-toast')}
      data-tone={tone}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false);
      }}
    >
      <Icon name={toneIcon[tone]} className="pos-toast__icon" />
      <div className="pos-toast__content">
        <div className="pos-toast__title">{entry.title}</div>
        {entry.description ? (
          <div className="pos-toast__description">{entry.description}</div>
        ) : null}
        {entry.action ? (
          <button
            type="button"
            className="pos-toast__action"
            onClick={() => {
              entry.action?.onClick();
              onDismiss(entry.id);
            }}
          >
            {entry.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        className="pos-toast__dismiss"
        aria-label={t('toast.dismiss')}
        onClick={() => onDismiss(entry.id)}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}
