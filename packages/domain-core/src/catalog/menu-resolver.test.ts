import { describe, expect, it } from 'vitest';

import { localDateTime } from '../time/business-date.js';
import { isoWeekday, localMoment } from './local-moment.js';
import {
  type MenuAssignmentCandidate,
  type MenuScopeRef,
  isScheduleActive,
  isValidAt,
  resolveMenu,
} from './menu-resolver.js';

const T = 'tenant-1';
const O = 'org-nsw';
const L = 'loc-syd';
const L2 = 'loc-mel';
const R = 'reg-1';
const SYD = 'Australia/Sydney';

/** The instant whose wall clock in `tz` is `date time` (works across DST by iterating the offset). */
export function zoned(date: string, time: string, tz: string): Date {
  const wanted = Date.parse(`${date}T${time}:00Z`);
  let guess = wanted;
  for (let i = 0; i < 3; i += 1) {
    const l = localDateTime(new Date(guess), tz);
    const seen = Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute);
    guess += wanted - seen;
  }
  return new Date(guess);
}

const a = (
  id: string,
  scopeKind: MenuAssignmentCandidate['scopeKind'],
  scopeId: string,
  priority: number,
  extra: Partial<MenuAssignmentCandidate> = {},
): MenuAssignmentCandidate => ({
  id,
  menuId: `menu-${id}`,
  scopeKind,
  scopeId,
  channel: 'all',
  schedule: {},
  validFrom: null,
  validTo: null,
  priority,
  menuStatus: 'published',
  ...extra,
});

const BASE: MenuAssignmentCandidate[] = [
  a('A1', 'tenant', T, 100),
  a('A2', 'location', L, 200, { schedule: { windows: [{ from: '06:00', to: '11:00' }] } }),
  a('A3', 'location', L, 200, {
    channel: 'dine_in',
    schedule: { windows: [{ from: '17:00', to: '22:00' }] },
  }),
  a('A4', 'register', R, 150, { channel: 'kiosk' }),
  a('A5', 'org_unit', O, 300, {
    schedule: { days: [5, 6], windows: [{ from: '22:00', to: '02:00' }] },
  }),
  a('A6', 'location', L, 500, {
    validFrom: zoned('2026-12-01', '00:00', SYD).toISOString(),
    validTo: zoned('2026-12-26', '00:00', SYD).toISOString(),
  }),
  a('A7', 'location', L, 100, { channel: 'delivery' }),
  a('A8', 'location', L, 250, { schedule: { days: [1] } }),
  a('A9', 'location', L, 999, { menuStatus: 'draft' }),
  a('A10', 'location', L, 200, { schedule: { windows: [{ from: '11:00', to: '17:00' }] } }),
  a('A11', 'location', L2, 1000),
  a('A12', 'tenant', T, 100, { channel: 'dine_in' }),
  a('A13', 'location', L, 900, { validFrom: zoned('2027-01-01', '00:00', SYD) }),
];

const TIE: MenuAssignmentCandidate[] = [
  a('A14', 'location', L, 100, { validFrom: '2026-01-01T00:00:00Z' }),
  a('A15', 'location', L, 100, { validFrom: '2026-06-01T00:00:00Z' }),
];

const withRegister: MenuScopeRef[] = [
  { kind: 'register', id: R },
  { kind: 'location', id: L },
  { kind: 'org_unit', id: O },
  { kind: 'tenant', id: T },
];
const locationOnly: MenuScopeRef[] = withRegister.slice(1);

interface Case {
  readonly name: string;
  readonly date: string;
  readonly time: string;
  readonly channel: string;
  readonly expected: string | null;
  readonly register?: boolean;
  readonly timezone?: string;
  readonly extra?: readonly MenuAssignmentCandidate[];
  readonly only?: readonly MenuAssignmentCandidate[];
}

// 2026-10-19 is a Monday; 2026-10-23 a Friday; 2026-12-26 a Saturday; 2026-11-30 a Monday.
const CASES: readonly Case[] = [
  {
    name: 'Monday breakfast: Monday menu (250) beats breakfast (200)',
    date: '2026-10-19',
    time: '08:30',
    channel: 'dine_in',
    expected: 'A8',
  },
  {
    name: 'Tuesday breakfast',
    date: '2026-10-20',
    time: '08:30',
    channel: 'dine_in',
    expected: 'A2',
  },
  {
    name: 'last minute of breakfast window',
    date: '2026-10-20',
    time: '10:59',
    channel: 'takeaway',
    expected: 'A2',
  },
  {
    name: 'window end is exclusive: 11:00 is lunch',
    date: '2026-10-20',
    time: '11:00',
    channel: 'takeaway',
    expected: 'A10',
  },
  { name: 'end of lunch', date: '2026-10-20', time: '16:59', channel: 'dine_in', expected: 'A10' },
  {
    name: 'dinner starts for dine-in',
    date: '2026-10-20',
    time: '17:00',
    channel: 'dine_in',
    expected: 'A3',
  },
  {
    name: 'dinner is dine-in only: takeaway falls back to the tenant menu',
    date: '2026-10-20',
    time: '17:00',
    channel: 'takeaway',
    expected: 'A1',
  },
  {
    name: 'equal priority: location delivery menu beats tenant-wide',
    date: '2026-10-20',
    time: '19:00',
    channel: 'delivery',
    expected: 'A7',
  },
  {
    name: 'register kiosk menu when the register is on the path',
    date: '2026-10-20',
    time: '19:00',
    channel: 'kiosk',
    expected: 'A4',
    register: true,
  },
  {
    name: 'register assignment ignored without the register',
    date: '2026-10-20',
    time: '19:00',
    channel: 'kiosk',
    expected: 'A1',
  },
  {
    name: 'nothing scheduled: channel-specific tenant menu beats tenant all',
    date: '2026-10-20',
    time: '03:00',
    channel: 'dine_in',
    expected: 'A12',
  },
  {
    name: 'nothing scheduled, takeaway: tenant all',
    date: '2026-10-20',
    time: '03:00',
    channel: 'takeaway',
    expected: 'A1',
  },
  {
    name: 'Friday late night (org unit, 300)',
    date: '2026-10-23',
    time: '23:00',
    channel: 'dine_in',
    expected: 'A5',
  },
  {
    name: 'Saturday 01:30 carries over from Friday night',
    date: '2026-10-24',
    time: '01:30',
    channel: 'dine_in',
    expected: 'A5',
  },
  {
    name: 'Saturday 02:00: overnight window ended (exclusive)',
    date: '2026-10-24',
    time: '02:00',
    channel: 'dine_in',
    expected: 'A12',
  },
  {
    name: 'Sunday 01:30 carries over from Saturday night',
    date: '2026-10-25',
    time: '01:30',
    channel: 'dine_in',
    expected: 'A5',
  },
  {
    name: 'Monday 01:30: Sunday is not a late-night day, Monday menu applies',
    date: '2026-10-26',
    time: '01:30',
    channel: 'dine_in',
    expected: 'A8',
  },
  {
    name: 'Thursday 23:00: not a late-night day',
    date: '2026-10-22',
    time: '23:00',
    channel: 'dine_in',
    expected: 'A12',
  },
  {
    name: 'Friday 21:59: still dinner',
    date: '2026-10-23',
    time: '21:59',
    channel: 'dine_in',
    expected: 'A3',
  },
  {
    name: 'Friday 22:00: late night starts (inclusive)',
    date: '2026-10-23',
    time: '22:00',
    channel: 'dine_in',
    expected: 'A5',
  },
  {
    name: 'Christmas menu inside its validity',
    date: '2026-12-24',
    time: '12:00',
    channel: 'dine_in',
    expected: 'A6',
  },
  {
    name: 'validTo is exclusive: Boxing Day 00:00 is Friday late night carry-over',
    date: '2026-12-26',
    time: '00:00',
    channel: 'dine_in',
    expected: 'A5',
  },
  {
    name: 'the night before validFrom',
    date: '2026-11-30',
    time: '23:59',
    channel: 'dine_in',
    expected: 'A8',
  },
  {
    name: 'validFrom is inclusive',
    date: '2026-12-01',
    time: '00:00',
    channel: 'dine_in',
    expected: 'A6',
  },
  {
    name: 'draft menus never resolve (A9 priority 999 ignored)',
    date: '2026-10-20',
    time: '09:00',
    channel: 'dine_in',
    expected: 'A2',
  },
  {
    name: 'assignments of another location are ignored (A11 priority 1000)',
    date: '2026-10-21',
    time: '09:00',
    channel: 'dine_in',
    expected: 'A2',
  },
  {
    name: 'Monday kiosk at the register: Monday menu (250) beats kiosk (150)',
    date: '2026-10-19',
    time: '08:30',
    channel: 'kiosk',
    expected: 'A8',
    register: true,
  },
  {
    name: 'Monday 03:00 kiosk: all-day Monday menu',
    date: '2026-10-19',
    time: '03:00',
    channel: 'kiosk',
    expected: 'A8',
    register: true,
  },
  {
    name: 'Sunday lunch via QR',
    date: '2026-10-25',
    time: '12:00',
    channel: 'qr',
    expected: 'A10',
  },
  {
    name: 'DST start day (Sydney, 4 Oct 2026) breakfast',
    date: '2026-10-04',
    time: '10:30',
    channel: 'dine_in',
    expected: 'A2',
  },
  {
    name: 'AEST (winter) breakfast',
    date: '2026-07-14',
    time: '08:00',
    channel: 'dine_in',
    expected: 'A2',
  },
  {
    name: 'same instant in Perth is 05:30: before breakfast',
    date: '2026-10-20',
    time: '08:30',
    channel: 'dine_in',
    expected: 'A12',
    timezone: 'Australia/Perth',
  },
  {
    name: 'open-ended validFrom in the future is not yet active',
    date: '2026-12-24',
    time: '12:00',
    channel: 'takeaway',
    expected: 'A6',
  },
  {
    name: 'open-ended validFrom once reached',
    date: '2027-01-05',
    time: '12:00',
    channel: 'takeaway',
    expected: 'A13',
  },
  {
    name: 'full tie: latest validFrom wins',
    date: '2026-10-20',
    time: '03:00',
    channel: 'takeaway',
    expected: 'A15',
    extra: TIE,
  },
  {
    name: 'no assignments at all',
    date: '2026-10-20',
    time: '09:00',
    channel: 'dine_in',
    expected: null,
    only: [],
  },
  {
    name: 'window with from === to is all day',
    date: '2026-10-20',
    time: '03:00',
    channel: 'dine_in',
    expected: 'X1',
    extra: [
      a('X1', 'location', L, 400, { schedule: { windows: [{ from: '09:00', to: '09:00' }] } }),
    ],
  },
];

describe('resolveMenu', () => {
  it('has at least 30 table cases', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
  });

  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const timezone = c.timezone ?? SYD;
    // Instants are expressed as Sydney wall-clock times so the Perth case shares the same instant.
    const at = zoned(c.date, c.time, SYD);
    const assignments = c.only ?? [...BASE, ...(c.extra ?? [])];
    const result = resolveMenu(assignments, {
      scopePath: c.register ? withRegister : locationOnly,
      channel: c.channel,
      at,
      timezone,
    });
    expect(result.winner?.id ?? null).toBe(c.expected);
    if (result.winner) expect(result.ranked[0]).toBe(result.winner);
    for (const candidate of result.ranked) expect(candidate.menuStatus).toBe('published');
  });

  it('ranks every eligible assignment, best first', () => {
    const result = resolveMenu(BASE, {
      scopePath: withRegister,
      channel: 'kiosk',
      at: zoned('2026-10-20', '08:30', SYD),
      timezone: SYD,
    });
    expect(result.ranked.map((r) => r.id)).toEqual(['A2', 'A4', 'A1']);
    expect(result.local).toEqual({ date: '2026-10-20', time: '08:30', weekday: 2, minutes: 510 });
  });

  it('treats an unparseable validity bound as unbounded', () => {
    expect(isValidAt({ validFrom: 'not a date', validTo: null }, new Date())).toBe(true);
  });
});

describe('isScheduleActive', () => {
  const monday0130 = { date: '2026-10-19', time: '01:30', weekday: 1, minutes: 90 };
  const sunday2330 = { date: '2026-10-18', time: '23:30', weekday: 7, minutes: 23 * 60 + 30 };

  it('empty schedule is always active', () => {
    expect(isScheduleActive({}, monday0130)).toBe(true);
    expect(isScheduleActive(undefined, monday0130)).toBe(true);
  });

  it('days without windows cover the whole local day', () => {
    expect(isScheduleActive({ days: [1] }, monday0130)).toBe(true);
    expect(isScheduleActive({ days: [7] }, monday0130)).toBe(false);
  });

  it('an overnight window on Sunday reaches into Monday morning', () => {
    const schedule = { days: [7], windows: [{ from: '22:00', to: '02:00' }] };
    expect(isScheduleActive(schedule, sunday2330)).toBe(true);
    expect(isScheduleActive(schedule, monday0130)).toBe(true);
    expect(
      isScheduleActive({ days: [1], windows: [{ from: '22:00', to: '02:00' }] }, monday0130),
    ).toBe(false);
  });

  it('rejects malformed times', () => {
    expect(() =>
      isScheduleActive({ windows: [{ from: '25:00', to: '26:00' }] }, monday0130),
    ).toThrow(RangeError);
  });
});

describe('localMoment', () => {
  it('computes the ISO weekday and minutes in the zone', () => {
    expect(isoWeekday(2026, 10, 18)).toBe(7);
    expect(isoWeekday(2026, 10, 19)).toBe(1);
    expect(localMoment(new Date('2026-10-18T13:05:00Z'), 'Australia/Sydney')).toEqual({
      date: '2026-10-19',
      time: '00:05',
      weekday: 1,
      minutes: 5,
    });
  });
});
