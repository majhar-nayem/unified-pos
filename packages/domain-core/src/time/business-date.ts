/**
 * Business date (docs/01-system-architecture.md §3): the trading day an instant belongs to.
 * A location's day rolls over at `boundary` local time (default 04:00), so 01:30 on the 19th
 * still belongs to the 18th. Pure and dependency-free: wall-clock conversion uses Intl.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

export interface LocalDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

/** Wall-clock components of `instant` in `timezone` (IANA name). Throws on an unknown zone. */
export function localDateTime(instant: Date, timezone: string): LocalDateTime {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timezone).formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts['year'] ?? 0,
    month: parts['month'] ?? 0,
    day: parts['day'] ?? 0,
    // Some runtimes render midnight as "24" with hourCycle h23 on older ICU; normalise.
    hour: (parts['hour'] ?? 0) % 24,
    minute: parts['minute'] ?? 0,
  };
}

/** Parse 'HH:MM' into minutes since midnight. Throws on malformed input. */
export function parseTimeOfDay(boundary: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(boundary);
  if (!match) throw new RangeError(`Invalid time of day: ${boundary} (expected HH:MM)`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** Format calendar components as YYYY-MM-DD. */
export function formatCalendarDate(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** Shift a calendar date by whole days using UTC arithmetic (no DST involvement). */
export function addCalendarDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return formatCalendarDate(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  );
}

/**
 * The business date (YYYY-MM-DD) of `instant` at a location in `timezone` whose day starts at
 * `boundary` ('HH:MM' local time). Before the boundary the instant belongs to the previous
 * calendar day.
 */
export function businessDate(instant: Date, timezone: string, boundary: string): string {
  const boundaryMinutes = parseTimeOfDay(boundary);
  const local = localDateTime(instant, timezone);
  const calendarDate = formatCalendarDate(local.year, local.month, local.day);
  const localMinutes = local.hour * 60 + local.minute;
  return localMinutes < boundaryMinutes ? addCalendarDays(calendarDate, -1) : calendarDate;
}
