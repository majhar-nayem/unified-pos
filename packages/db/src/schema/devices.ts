import { integer, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { bytea } from './common.js';

/** Drizzle mirror of db/schema_part3.sql (devices), the tables F1 touches. */
export const devicesSchema = pgSchema('devices');

export const devices = devicesSchema.table('devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  locationId: uuid('location_id').notNull(),
  registerId: uuid('register_id'),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  platform: text('platform'),
  appVersion: text('app_version'),
  schemaVersion: integer('schema_version'),
  enrollmentStatus: text('enrollment_status').notNull().default('pending'),
  publicKey: bytea('public_key'),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  wipeRequestedAt: timestamp('wipe_requested_at', { withTimezone: true }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  health: jsonb('health').notNull().default({}),
  settings: jsonb('settings').notNull().default({}),
});

export const deviceEnrollmentCodes = devicesSchema.table('device_enrollment_codes', {
  code: text('code').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  locationId: uuid('location_id').notNull(),
  registerId: uuid('register_id'),
  kind: text('kind').notNull(),
  createdBy: uuid('created_by').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  usedByDeviceId: uuid('used_by_device_id'),
});
