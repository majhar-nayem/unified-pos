/**
 * Menu resolution (docs/02-database-design.md §2.2): which menu applies at a location (or
 * register) for a channel at an instant. Pure: the same code runs on the server and inside the
 * POS app against the replicated `catalog.menu_assignments` rows.
 *
 * Eligibility: the assignment's scope is on the request's scope path, its channel is `all` or
 * the request's channel, the instant is inside [validFrom, validTo) and the schedule admits the
 * local weekday and time. Ranking: priority (higher wins), then the nearest scope (register >
 * location > org unit > tenant), then a specific channel over `all`, then the latest validFrom,
 * then id for determinism.
 */
import { parseTimeOfDay } from '../time/business-date.js';
import { type LocalMoment, localMoment } from './local-moment.js';

export type MenuScopeKind = 'tenant' | 'org_unit' | 'location' | 'register';

export interface MenuScopeRef {
  readonly kind: MenuScopeKind;
  readonly id: string;
}

export interface MenuWindow {
  readonly from: string; // HH:MM, inclusive
  readonly to: string; // HH:MM, exclusive; earlier than `from` = spans midnight
}

export interface MenuSchedule {
  /** ISO weekdays 1 = Monday … 7 = Sunday. Empty/absent = every day. */
  readonly days?: readonly number[];
  /** Empty/absent = all day. */
  readonly windows?: readonly MenuWindow[];
}

export interface MenuAssignmentCandidate {
  readonly id: string;
  readonly menuId: string;
  readonly scopeKind: MenuScopeKind;
  readonly scopeId: string;
  /** `all` or a concrete channel. */
  readonly channel: string;
  readonly schedule: MenuSchedule;
  readonly validFrom: string | Date | null;
  readonly validTo: string | Date | null;
  readonly priority: number;
  /** Only `published` menus resolve; omit when the caller pre-filtered. */
  readonly menuStatus?: string;
}

export interface MenuResolveContext {
  /** Nearest first: [register?, location, org units (nearest first)…, tenant]. */
  readonly scopePath: readonly MenuScopeRef[];
  readonly channel: string;
  readonly at: Date;
  /** IANA time zone of the location. */
  readonly timezone: string;
}

export interface MenuResolution<T extends MenuAssignmentCandidate = MenuAssignmentCandidate> {
  readonly winner: T | null;
  /** Every eligible assignment, best first. */
  readonly ranked: readonly T[];
  readonly local: LocalMoment;
}

const DAY_MINUTES = 24 * 60;

/** True when `local` falls inside the schedule (see MenuSchedule for the midnight rule). */
export function isScheduleActive(schedule: MenuSchedule | undefined, local: LocalMoment): boolean {
  const days = schedule?.days ?? [];
  const windows = schedule?.windows ?? [];
  const dayAllowed = (weekday: number) => days.length === 0 || days.includes(weekday);
  if (windows.length === 0) return dayAllowed(local.weekday);
  const previousDay = local.weekday === 1 ? 7 : local.weekday - 1;
  for (const window of windows) {
    const from = parseTimeOfDay(window.from);
    const to = parseTimeOfDay(window.to);
    if (from < to) {
      if (dayAllowed(local.weekday) && local.minutes >= from && local.minutes < to) return true;
    } else if (from > to) {
      // Spans midnight: the evening part belongs to this day, the early part to the previous day's entry.
      if (dayAllowed(local.weekday) && local.minutes >= from) return true;
      if (dayAllowed(previousDay) && local.minutes < to) return true;
    } else if (dayAllowed(local.weekday)) {
      return true; // from === to: a full 24 h window
    }
  }
  return false;
}

function instant(value: string | Date | null): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Inside [validFrom, validTo) — half-open like every validity window in the platform. */
export function isValidAt(
  candidate: Pick<MenuAssignmentCandidate, 'validFrom' | 'validTo'>,
  at: Date,
): boolean {
  const t = at.getTime();
  const from = instant(candidate.validFrom);
  const to = instant(candidate.validTo);
  if (from !== null && t < from) return false;
  if (to !== null && t >= to) return false;
  return true;
}

export function resolveMenu<T extends MenuAssignmentCandidate>(
  assignments: readonly T[],
  context: MenuResolveContext,
): MenuResolution<T> {
  const local = localMoment(context.at, context.timezone);
  const pathIndex = new Map<string, number>();
  context.scopePath.forEach((scope, index) => pathIndex.set(`${scope.kind}:${scope.id}`, index));

  const eligible = assignments.filter((a) => {
    if (a.menuStatus !== undefined && a.menuStatus !== 'published') return false;
    if (!pathIndex.has(`${a.scopeKind}:${a.scopeId}`)) return false;
    if (a.channel !== 'all' && a.channel !== context.channel) return false;
    if (!isValidAt(a, context.at)) return false;
    return isScheduleActive(a.schedule, local);
  });

  const ranked = [...eligible].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    const scopeA = pathIndex.get(`${a.scopeKind}:${a.scopeId}`) ?? Number.MAX_SAFE_INTEGER;
    const scopeB = pathIndex.get(`${b.scopeKind}:${b.scopeId}`) ?? Number.MAX_SAFE_INTEGER;
    if (scopeA !== scopeB) return scopeA - scopeB;
    const channelA = a.channel === 'all' ? 1 : 0;
    const channelB = b.channel === 'all' ? 1 : 0;
    if (channelA !== channelB) return channelA - channelB;
    const fromA = instant(a.validFrom) ?? Number.NEGATIVE_INFINITY;
    const fromB = instant(b.validFrom) ?? Number.NEGATIVE_INFINITY;
    if (fromA !== fromB) return fromB - fromA;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return { winner: ranked[0] ?? null, ranked, local };
}

export { DAY_MINUTES as MENU_DAY_MINUTES };
