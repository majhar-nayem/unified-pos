import { IntlMessageFormat } from 'intl-messageformat';

import { baseLocale, catalogs, type CatalogLocale, type MessageKey } from './catalogs.generated.js';

export type MessageValues = Record<string, string | number | boolean | Date | null | undefined>;
export type MessageOverrides = Partial<Record<MessageKey, string>>;
export type Translate = (key: MessageKey, values?: MessageValues) => string;

const cache = new Map<string, IntlMessageFormat>();

function compiled(locale: string, source: string): IntlMessageFormat {
  const cacheKey = `${locale}\u0000${source}`;
  let message = cache.get(cacheKey);
  if (!message) {
    message = new IntlMessageFormat(source, locale);
    cache.set(cacheKey, message);
  }
  return message;
}

function catalogFor(locale: string): Partial<Record<MessageKey, string>> {
  const exact = catalogs[locale as CatalogLocale];
  if (exact) return exact;
  const language = locale.split('-')[0] ?? locale;
  const sameLanguage = Object.keys(catalogs).find((l) => l.split('-')[0] === language);
  return sameLanguage ? catalogs[sameLanguage as CatalogLocale] : {};
}

/**
 * Builds a translator. Resolution order: tenant/app overrides, the locale catalog, the en-AU base.
 * A missing key renders as the key itself so the gap is visible rather than blank.
 */
export function createTranslator(locale: string, overrides?: MessageOverrides): Translate {
  const catalog = catalogFor(locale);
  const base = catalogs[baseLocale];
  return (key, values) => {
    const source = overrides?.[key] ?? catalog[key] ?? base[key];
    if (source === undefined) return key;
    const result = compiled(locale, source).format(values as Record<string, never> | undefined);
    return Array.isArray(result) ? result.join('') : String(result);
  };
}
