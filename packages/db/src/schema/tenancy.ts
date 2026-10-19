import {
  boolean,
  char,
  date,
  integer,
  jsonb,
  pgSchema,
  point,
  text,
  time,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** Drizzle mirror of db/schema.sql (tenancy) + migration 0002 columns. */
export const tenancySchema = pgSchema('tenancy');

export const legalEntities = tenancySchema.table('legal_entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  countryCode: char('country_code', { length: 2 }).notNull(),
  registrationNumber: text('registration_number'),
  taxRegistrationNumber: text('tax_registration_number'),
  address: jsonb('address').notNull().default({}),
  receiptLegalText: text('receipt_legal_text'),
  fiscalSettings: jsonb('fiscal_settings').notNull().default({}),
  status: text('status').notNull().default('active'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const orgUnits = tenancySchema.table('org_units', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  parentId: uuid('parent_id'),
  kind: text('kind').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  legalEntityId: uuid('legal_entity_id'),
  reportingBoundary: boolean('reporting_boundary').notNull().default(false),
  settings: jsonb('settings').notNull().default({}),
  status: text('status').notNull().default('active'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const orgUnitPaths = tenancySchema.table('org_unit_paths', {
  tenantId: uuid('tenant_id').notNull(),
  ancestorId: uuid('ancestor_id').notNull(),
  descendantId: uuid('descendant_id').notNull(),
  depth: integer('depth').notNull(),
});

export const locations = tenancySchema.table('locations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  orgUnitId: uuid('org_unit_id').notNull(),
  legalEntityId: uuid('legal_entity_id'),
  code: text('code').notNull(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  deploymentProfile: text('deployment_profile').notNull().default('device_autonomous'),
  timezone: text('timezone').notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  locale: text('locale').notNull().default('en-AU'),
  businessDayBoundary: time('business_day_boundary').notNull().default('04:00'),
  address: jsonb('address').notNull().default({}),
  geo: point('geo'),
  businessHours: jsonb('business_hours').notNull().default({}),
  settings: jsonb('settings').notNull().default({}),
  status: text('status').notNull().default('active'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const departments = tenancySchema.table('departments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  locationId: uuid('location_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('general'),
  status: text('status').notNull().default('active'),
  version: integer('version').notNull().default(1),
});

export const registers = tenancySchema.table('registers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  locationId: uuid('location_id').notNull(),
  departmentId: uuid('department_id'),
  code: text('code').notNull(),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('pos'),
  settings: jsonb('settings').notNull().default({}),
  status: text('status').notNull().default('active'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const configEntries = tenancySchema.table('config_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  scopeKind: text('scope_kind').notNull(),
  scopeId: uuid('scope_id').notNull(),
  key: text('key').notNull(),
  value: jsonb('value').notNull(),
  version: integer('version').notNull(),
  isCurrent: boolean('is_current').notNull().default(true),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  reason: text('reason'),
});

export const businessDays = tenancySchema.table('business_days', {
  tenantId: uuid('tenant_id').notNull(),
  locationId: uuid('location_id').notNull(),
  businessDate: date('business_date').notNull(),
  status: text('status').notNull().default('open'),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedBy: uuid('closed_by'),
});
