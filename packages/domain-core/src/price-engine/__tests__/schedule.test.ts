import { describe, expect, it } from 'vitest';

import { inWindow, isoWeekday, localMomentOf, parseInstant, scheduleAllows } from '../schedule.js';

describe('schedule', () => {
  it('computes ISO weekdays', () => {
    expect(isoWeekday(2026, 10, 19)).toBe(1); // Monday
    expect(isoWeekday(2026, 10, 18)).toBe(7); // Sunday
    expect(isoWeekday(2026, 10, 24)).toBe(6);
  });

  it('converts an instant to the location wall clock', () => {
    const m = localMomentOf(new Date('2026-10-19T05:30:00Z'), 'Australia/Sydney');
    expect(m).toEqual({ date: '2026-10-19', weekday: 1, minutes: 16 * 60 + 30 });
    const utc = localMomentOf(new Date('2026-10-19T05:30:00Z'), 'UTC');
    expect(utc.minutes).toBe(5 * 60 + 30);
    // Sydney is already on the 20th at 14:00Z.
    expect(localMomentOf(new Date('2026-10-19T14:00:00Z'), 'Australia/Sydney').date).toBe(
      '2026-10-20',
    );
  });

  it('windows are [from, to) and wrap past midnight', () => {
    expect(inWindow(16 * 60, '16:00', '18:00')).toBe(true);
    expect(inWindow(17 * 60 + 59, '16:00', '18:00')).toBe(true);
    expect(inWindow(18 * 60, '16:00', '18:00')).toBe(false);
    expect(inWindow(15 * 60 + 59, '16:00', '18:00')).toBe(false);
    expect(inWindow(23 * 60, '22:00', '02:00')).toBe(true);
    expect(inWindow(60, '22:00', '02:00')).toBe(true);
    expect(inWindow(2 * 60, '22:00', '02:00')).toBe(false);
    expect(inWindow(12 * 60, '22:00', '02:00')).toBe(false);
  });

  it('scheduleAllows combines days and windows; empty means always', () => {
    const monday430 = { date: '2026-10-19', weekday: 1, minutes: 16 * 60 + 30 };
    expect(scheduleAllows(undefined, monday430)).toBe(true);
    expect(scheduleAllows({}, monday430)).toBe(true);
    expect(scheduleAllows({ daysOfWeek: [], windows: [] }, monday430)).toBe(true);
    expect(scheduleAllows({ daysOfWeek: [1] }, monday430)).toBe(true);
    expect(scheduleAllows({ daysOfWeek: [2, 3] }, monday430)).toBe(false);
    expect(scheduleAllows({ windows: [{ from: '16:00', to: '17:00' }] }, monday430)).toBe(true);
    expect(
      scheduleAllows(
        {
          windows: [
            { from: '08:00', to: '09:00' },
            { from: '16:00', to: '17:00' },
          ],
        },
        monday430,
      ),
    ).toBe(true);
    expect(scheduleAllows({ windows: [{ from: '08:00', to: '09:00' }] }, monday430)).toBe(false);
    expect(
      scheduleAllows({ daysOfWeek: [1], windows: [{ from: '08:00', to: '09:00' }] }, monday430),
    ).toBe(false);
    expect(
      scheduleAllows({ daysOfWeek: [2], windows: [{ from: '16:00', to: '17:00' }] }, monday430),
    ).toBe(false);
  });

  it('parseInstant rejects garbage', () => {
    expect(parseInstant('2026-10-19T00:00:00Z', 'x').toISOString()).toBe(
      '2026-10-19T00:00:00.000Z',
    );
    expect(() => parseInstant('nope', 'context.at')).toThrow('context.at must be an ISO instant');
  });
});
