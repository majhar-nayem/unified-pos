import { formatCalendarDate, localDateTime, parseTimeOfDay } from '../time/business-date.js';

/**
 * Promotion schedule (pricing.promotions.schedule jsonb): optional ISO weekdays and local time
 * windows in the location's zone. An empty schedule means "always, within validFrom/validTo".
 */
export interface PromotionSchedule {
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  readonly daysOfWeek?: readonly number[];
  /** Local windows as HH:MM; a window crossing midnight ("22:00"–"02:00") wraps. */
  readonly windows?: readonly { readonly from: string; readonly to: string }[];
}

export interface LocalMomentInfo {
  readonly date: string;
  readonly weekday: number;
  readonly minutes: number;
}

export function isoWeekday(year: number, month: number, day: number): number {
  const sundayFirst = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return sundayFirst === 0 ? 7 : sundayFirst;
}

export function localMomentOf(at: Date, timezone: string): LocalMomentInfo {
  const local = localDateTime(at, timezone);
  return {
    date: formatCalendarDate(local.year, local.month, local.day),
    weekday: isoWeekday(local.year, local.month, local.day),
    minutes: local.hour * 60 + local.minute,
  };
}

export function scheduleAllows(
  schedule: PromotionSchedule | undefined,
  moment: LocalMomentInfo,
): boolean {
  if (!schedule) return true;
  if (schedule.daysOfWeek && schedule.daysOfWeek.length > 0) {
    if (!schedule.daysOfWeek.includes(moment.weekday)) return false;
  }
  if (schedule.windows && schedule.windows.length > 0) {
    return schedule.windows.some((w) => inWindow(moment.minutes, w.from, w.to));
  }
  return true;
}

/** [from, to): a window whose end is at or before its start wraps past midnight. */
export function inWindow(minutes: number, from: string, to: string): boolean {
  const start = parseTimeOfDay(from);
  const end = parseTimeOfDay(to);
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

export function parseInstant(value: string, label: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`${label} must be an ISO instant`);
  return date;
}
