import {
  ACTIVE_ARCHIVED,
  DEPARTMENT_KINDS,
  DEPLOYMENT_PROFILES,
  LOCATION_KINDS,
  LOCATION_STATUSES,
  ORG_UNIT_KINDS,
  REGISTER_KINDS,
  REGISTER_STATUSES,
  DEVICE_KINDS,
} from '@pos/contracts';

import { titleCase } from './format';

export const opts = (values: readonly string[]) =>
  values.map((v) => ({ value: v, label: titleCase(v) }));

export const ORG_UNIT_KIND_OPTIONS = opts(ORG_UNIT_KINDS);
export const LOCATION_KIND_OPTIONS = opts(LOCATION_KINDS);
export const DEPLOYMENT_PROFILE_OPTIONS = opts(DEPLOYMENT_PROFILES);
export const LOCATION_STATUS_OPTIONS = opts(LOCATION_STATUSES);
export const DEPARTMENT_KIND_OPTIONS = opts(DEPARTMENT_KINDS);
export const REGISTER_KIND_OPTIONS = opts(REGISTER_KINDS);
export const REGISTER_STATUS_OPTIONS = opts(REGISTER_STATUSES);
export const ACTIVE_ARCHIVED_OPTIONS = opts(ACTIVE_ARCHIVED);
export const DEVICE_KIND_OPTIONS = opts(DEVICE_KINDS);

/** IANA zones commonly used by AU/NZ and global retail; the field also accepts any other zone. */
export const COMMON_TIMEZONES = [
  'Australia/Sydney',
  'Australia/Melbourne',
  'Australia/Brisbane',
  'Australia/Adelaide',
  'Australia/Perth',
  'Australia/Darwin',
  'Australia/Hobart',
  'Pacific/Auckland',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
];

export function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
