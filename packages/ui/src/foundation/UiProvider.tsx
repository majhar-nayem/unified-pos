import {
  createContext,
  useContext,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

import { defaultThemeBySurface, themes, type Surface, type ThemeName } from '../tokens.js';
import { createTranslator, type MessageOverrides, type Translate } from '../i18n/translate.js';

import { resolveBrandAccent } from './contrast.js';
import { cx } from './cx.js';
import { createFormatter, type Formatter } from './format.js';

export interface UiContextValue {
  readonly surface: Surface;
  readonly theme: ThemeName;
  readonly locale: string;
  readonly currency: string;
  readonly t: Translate;
  readonly format: Formatter;
  /** Element that portalled UI (dialogs, toasts, tooltips) mounts into so it inherits theme variables. */
  readonly portalContainer: HTMLElement | null;
}

const DEFAULT_LOCALE = 'en-AU';
const DEFAULT_CURRENCY = 'AUD';

const defaultValue: UiContextValue = {
  surface: 'pos',
  theme: 'light',
  locale: DEFAULT_LOCALE,
  currency: DEFAULT_CURRENCY,
  t: createTranslator(DEFAULT_LOCALE),
  format: createFormatter(DEFAULT_LOCALE, DEFAULT_CURRENCY),
  portalContainer: null,
};

const UiContext = createContext<UiContextValue>(defaultValue);

export function useUi(): UiContextValue {
  return useContext(UiContext);
}

export interface UiProviderProps {
  /** Selects the type scale and control height. Defaults to `pos`. */
  readonly surface?: Surface;
  /** Defaults per surface: light for POS and admin, dark for KDS. */
  readonly theme?: ThemeName;
  readonly locale?: string;
  /** ISO 4217 code used by money formatting when a component does not pass one. */
  readonly currency?: string;
  /** Tenant or per-app copy overrides keyed by message key. */
  readonly messages?: MessageOverrides;
  /** POS large-text mode (x1.25). */
  readonly textScale?: 'normal' | 'large';
  /** Admin tables and controls. */
  readonly density?: 'comfortable' | 'compact';
  /** Tenant brand colour; applied to accents only, and only if it keeps contrast. */
  readonly brand?: string;
  readonly className?: string;
  readonly children: ReactNode;
}

export function UiProvider({
  surface = 'pos',
  theme,
  locale = DEFAULT_LOCALE,
  currency = DEFAULT_CURRENCY,
  messages,
  textScale = 'normal',
  density = 'comfortable',
  brand,
  className,
  children,
}: UiProviderProps) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const resolvedTheme = theme ?? defaultThemeBySurface[surface];

  const value = useMemo<UiContextValue>(
    () => ({
      surface,
      theme: resolvedTheme,
      locale,
      currency,
      t: createTranslator(locale, messages),
      format: createFormatter(locale, currency),
      portalContainer: container,
    }),
    [surface, resolvedTheme, locale, currency, messages, container],
  );

  const brandStyle = useMemo<CSSProperties | undefined>(() => {
    if (!brand) return undefined;
    const accent = resolveBrandAccent(brand, themes[resolvedTheme].color.surface);
    if (!accent) return undefined;
    return {
      '--pos-color-brand-solid': accent.solid,
      '--pos-color-brand-on-solid': accent.onSolid,
      '--pos-color-brand-border': accent.solid,
      '--pos-color-brand-subtle': `color-mix(in srgb, ${accent.solid} 14%, var(--pos-color-surface))`,
      '--pos-color-focus-ring': accent.solid,
    } as CSSProperties;
  }, [brand, resolvedTheme]);

  return (
    <UiContext.Provider value={value}>
      <div
        ref={setContainer}
        className={cx('pos-root', className)}
        data-surface={surface}
        data-theme={resolvedTheme}
        data-text-scale={textScale === 'large' ? 'large' : undefined}
        data-density={density}
        lang={locale}
        style={brandStyle}
      >
        {children}
      </div>
    </UiContext.Provider>
  );
}
