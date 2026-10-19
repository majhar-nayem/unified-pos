import { boolean, char, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { citext } from './common.js';

/** Drizzle mirror of db/schema.sql (platform). Identifiers + row types only; SQL stays explicit. */
export const platformSchema = pgSchema('platform');

export const operators = platformSchema.table('operators', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  status: text('status').notNull().default('active'),
  mfaEnforced: boolean('mfa_enforced').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tenants = platformSchema.table('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: citext('slug').notNull().unique(),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  plan: text('plan').notNull().default('standard'),
  region: text('region').notNull().default('ap-southeast-2'),
  defaultCurrency: char('default_currency', { length: 3 }).notNull().default('AUD'),
  defaultLocale: text('default_locale').notNull().default('en-AU'),
  defaultTimezone: text('default_timezone').notNull().default('Australia/Sydney'),
  settings: jsonb('settings').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const featureFlags = platformSchema.table('feature_flags', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull(),
  tenantId: uuid('tenant_id'),
  scopeKind: text('scope_kind').notNull().default('tenant'),
  scopeId: uuid('scope_id'),
  enabled: boolean('enabled').notNull().default(false),
  rules: jsonb('rules').notNull().default({}),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
