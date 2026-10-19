import { v7 as uuidv7 } from 'uuid';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Writer-generated UUIDv7 (docs/02-database-design.md §1): time-ordered, index-friendly. */
export function newId(): string {
  return uuidv7();
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function assertUuid(value: string, label = 'id'): void {
  if (!isUuid(value)) throw new TypeError(`${label} must be a UUID, got "${value}"`);
}
