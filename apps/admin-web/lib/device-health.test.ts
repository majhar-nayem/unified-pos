import { describe, expect, it } from 'vitest';

import { deviceHealth, needsAttention } from './device-health';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const enrolled = (lastSeenAt: string | null) => ({
  enrollmentStatus: 'enrolled' as const,
  lastSeenAt,
  enrolledAt: ago(1e9),
});

describe('deviceHealth', () => {
  it('classifies by how long ago the device called the API', () => {
    expect(deviceHealth(enrolled(ago(30_000)), NOW)).toBe('healthy');
    expect(deviceHealth(enrolled(ago(5 * 60_000)), NOW)).toBe('healthy');
    expect(deviceHealth(enrolled(ago(5 * 60_000 + 1)), NOW)).toBe('delayed');
    expect(deviceHealth(enrolled(ago(60 * 60_000)), NOW)).toBe('delayed');
    expect(deviceHealth(enrolled(ago(60 * 60_000 + 1)), NOW)).toBe('offline');
  });
  it('flags a device that never connected and ignores revoked or wiped ones', () => {
    expect(deviceHealth(enrolled(null), NOW)).toBe('never_connected');
    for (const enrollmentStatus of ['revoked', 'wiped', 'pending'] as const) {
      expect(deviceHealth({ enrollmentStatus, lastSeenAt: ago(1), enrolledAt: null }, NOW)).toBe(
        'inactive',
      );
    }
  });
  it('only offline and never-connected need attention', () => {
    expect(
      ['healthy', 'delayed', 'offline', 'never_connected', 'inactive'].filter((h) =>
        needsAttention(h as never),
      ),
    ).toEqual(['offline', 'never_connected']);
  });
});
