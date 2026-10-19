import { formatCalendarDate, localDateTime } from '../time/business-date.js';

/** Wall-clock position of an instant in a location's time zone, as the menu resolver sees it. */
export interface LocalMoment {
  /** YYYY-MM-DD */
  readonly date: string;
  /** HH:MM */
  readonly time: string;
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  readonly weekday: number;
  /** Minutes since local midnight. */
  readonly minutes: number;
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a calendar date, via UTC arithmetic (no DST involved). */
export function isoWeekday(year: number, month: number, day: number): number {
  const sundayFirst = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday
  return sundayFirst === 0 ? 7 : sundayFirst;
}

export function localMoment(at: Date, timezone: string): LocalMoment {
  const local = localDateTime(at, timezone);
  const minutes = local.hour * 60 + local.minute;
  return {
    date: formatCalendarDate(local.year, local.month, local.day),
    time: `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`,
    weekday: isoWeekday(local.year, local.month, local.day),
    minutes,
  };
}
