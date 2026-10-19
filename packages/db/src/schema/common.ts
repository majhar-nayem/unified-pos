import { customType } from 'drizzle-orm/pg-core';

/** Postgres citext (case-insensitive text). */
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
});

/** Postgres bytea as Buffer. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});