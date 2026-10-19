import type { DeviceDto } from '@pos/contracts';

export type DeviceHealth = 'healthy' | 'delayed' | 'offline' | 'never_connected' | 'inactive';

export const HEALTHY_WITHIN_MS = 5 * 60_000;
export const DELAYED_WITHIN_MS = 60 * 60_000;

/**
 * Device health from the only signal the API exposes today: `lastSeenAt` (touched on each
 * authenticated device request). Heartbeat metrics (printer, battery, sync backlog) arrive with
 * the POS shell and are not guessed here.
 */
export function deviceHealth(
  device: Pick<DeviceDto, 'enrollmentStatus' | 'lastSeenAt' | 'enrolledAt'>,
  now = Date.now(),
): DeviceHealth {
  if (device.enrollmentStatus !== 'enrolled') return 'inactive';
  if (!device.lastSeenAt) return 'never_connected';
  const age = now - Date.parse(device.lastSeenAt);
  if (age <= HEALTHY_WITHIN_MS) return 'healthy';
  if (age <= DELAYED_WITHIN_MS) return 'delayed';
  return 'offline';
}

export const HEALTH_LABEL: Record<DeviceHealth, string> = {
  healthy: 'Healthy',
  delayed: 'Delayed',
  offline: 'Offline',
  never_connected: 'Never connected',
  inactive: 'Inactive',
};

export function needsAttention(h: DeviceHealth): boolean {
  return h === 'offline' || h === 'never_connected';
}
