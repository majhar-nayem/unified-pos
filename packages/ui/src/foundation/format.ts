/**
 * Number, money, duration and date formatting through Intl with the location locale. Money is always an
 * integer count of minor units (cents), matching the domain layer; the exponent comes from the currency.
 */
export interface Formatter {
  readonly locale: string;
  readonly currency: string;
  money(minor: number, currency?: string): string;
  /** Signed money with an explicit sign for refunds and discounts: "-$4.50". */
  signedMoney(minor: number, currency?: string): string;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  /** "3:12" for under an hour, "1:03:12" otherwise. Input in seconds. */
  duration(totalSeconds: number): string;
  time(date: Date | number): string;
  dateTime(date: Date | number): string;
}

export function minorUnitExponent(currency: string, locale: string): number {
  return (
    new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

export function createFormatter(locale: string, defaultCurrency: string): Formatter {
  const moneyFormats = new Map<string, Intl.NumberFormat>();
  const moneyFormat = (currency: string) => {
    let f = moneyFormats.get(currency);
    if (!f) {
      f = new Intl.NumberFormat(locale, { style: 'currency', currency });
      moneyFormats.set(currency, f);
    }
    return f;
  };
  const toMajor = (minor: number, currency: string) =>
    minor / 10 ** minorUnitExponent(currency, locale);
  const pad = (n: number) => String(n).padStart(2, '0');

  return {
    locale,
    currency: defaultCurrency,
    money: (minor, currency = defaultCurrency) =>
      moneyFormat(currency).format(toMajor(minor, currency)),
    signedMoney: (minor, currency = defaultCurrency) =>
      new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        signDisplay: 'exceptZero',
      }).format(toMajor(minor, currency)),
    number: (value, options) => new Intl.NumberFormat(locale, options).format(value),
    duration: (totalSeconds) => {
      const s = Math.max(0, Math.floor(totalSeconds));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
    },
    time: (date) => new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(date),
    dateTime: (date) =>
      new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date),
  };
}
