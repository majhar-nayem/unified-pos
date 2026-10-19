import { describe, expect, it } from 'vitest';

import { addCalendarDays, businessDate, localDateTime, parseTimeOfDay } from './business-date.js';

const SYDNEY = 'Australia/Sydney';

describe('businessDate()', () => {
  it('03:59 Sydney with a 04:00 boundary belongs to the previous day', () => {
    // AEDT (UTC+11) on 2026-01-15: 03:59 local = 16:59Z the day before.
    expect(businessDate(new Date('2026-01-14T16:59:00Z'), SYDNEY, '04:00')).toBe('2026-01-14');
  });

  it('04:00 Sydney with a 04:00 boundary is the same day', () => {
    expect(businessDate(new Date('2026-01-14T17:00:00Z'), SYDNEY, '04:00')).toBe('2026-01-15');
  });

  it('a UTC instant that is already the next day in Sydney uses the local date', () => {
    // 2026-06-10 20:30Z is 2026-06-11 06:30 AEST (UTC+10): after the boundary, so the 11th.
    expect(businessDate(new Date('2026-06-10T20:30:00Z'), SYDNEY, '04:00')).toBe('2026-06-11');
    // 2026-06-10 15:30Z is 2026-06-11 01:30 AEST: before the boundary, so still the 10th.
    expect(businessDate(new Date('2026-06-10T15:30:00Z'), SYDNEY, '04:00')).toBe('2026-06-10');
  });

  it('handles the DST transition day (Sydney springs forward 2026-10-04 02:00 → 03:00)', () => {
    // 2026-10-03 15:30Z = 2026-10-04 01:30 AEST (before the jump): before 04:00 → the 3rd.
    expect(businessDate(new Date('2026-10-03T15:30:00Z'), SYDNEY, '04:00')).toBe('2026-10-03');
    // 2026-10-03 16:30Z = 2026-10-04 03:30 AEDT (after the jump): still before 04:00 → the 3rd.
    expect(businessDate(new Date('2026-10-03T16:30:00Z'), SYDNEY, '04:00')).toBe('2026-10-03');
    // 2026-10-03 17:00Z = 2026-10-04 04:00 AEDT: boundary reached → the 4th.
    expect(businessDate(new Date('2026-10-03T17:00:00Z'), SYDNEY, '04:00')).toBe('2026-10-04');
    // Fall back (2027-04-04 03:00 AEDT → 02:00 AEST): 2027-04-03 16:30Z = 02:30 AEST → the 3rd.
    expect(businessDate(new Date('2027-04-03T16:30:00Z'), SYDNEY, '04:00')).toBe('2027-04-03');
  });

  it('a 00:00 boundary is the plain local calendar date', () => {
    expect(businessDate(new Date('2026-01-14T13:00:00Z'), SYDNEY, '00:00')).toBe('2026-01-15');
    expect(businessDate(new Date('2026-01-14T12:59:00Z'), SYDNEY, '00:00')).toBe('2026-01-14');
  });

  it('crosses month and year boundaries when stepping back a day', () => {
    // 2026-01-01 02:00 AEDT = 2025-12-31 15:00Z → business date 2025-12-31.
    expect(businessDate(new Date('2025-12-31T15:00:00Z'), SYDNEY, '04:00')).toBe('2025-12-31');
    expect(businessDate(new Date('2026-03-01T01:00:00Z'), 'UTC', '04:00')).toBe('2026-02-28');
  });

  it('rejects malformed boundaries and unknown zones', () => {
    expect(() => parseTimeOfDay('4:00')).toThrow(RangeError);
    expect(() => parseTimeOfDay('24:00')).toThrow(RangeError);
    expect(() => businessDate(new Date(), 'Mars/Olympus_Mons', '04:00')).toThrow(RangeError);
  });
});

describe('helpers', () => {
  it('localDateTime renders midnight as hour 0', () => {
    expect(localDateTime(new Date('2026-01-14T13:00:00Z'), SYDNEY)).toEqual({
      year: 2026,
      month: 1,
      day: 15,
      hour: 0,
      minute: 0,
    });
  });

  it('addCalendarDays steps across leap days', () => {
    expect(addCalendarDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addCalendarDays('2027-12-31', 1)).toBe('2028-01-01');
  });
});
