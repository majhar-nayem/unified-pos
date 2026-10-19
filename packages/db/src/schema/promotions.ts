import {
  bigint,
  boolean,
  char,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of db/schema_part2.sql (pricing: price lists, promotions, coupons) for slice F3.
 * Identifiers and row types only; SQL stays explicit in the repositories. The schema object is
 * declared here (not imported from ./pricing.js, which belongs to the tax stream) so the two
 * mirrors stay independent; Drizzle treats both as the same `pricing` Postgres schema.
 */
const pricing = pgSchema('pricing');

export const priceLists = pricing.table('price_lists', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  kind: text('kind').notNull().default('retail'),
  taxInclusive: boolean('tax_inclusive').notNull().default(true),
  priority: integer('priority').notNull().default(100),
  status: text('status').notNull().default('active'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const priceListEntries = pricing.table('price_list_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  priceListId: uuid('price_list_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  priceMinor: bigint('price_minor', { mode: 'bigint' }).notNull(),
  minQuantity: numeric('min_quantity', { precision: 14, scale: 4 }).notNull().default('1'),
  validFrom: timestamp('valid_from', { withTimezone: true }),
  validTo: timestamp('valid_to', { withTimezone: true }),
});

export const priceListAssignments = pricing.table('price_list_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  priceListId: uuid('price_list_id').notNull(),
  scopeKind: text('scope_kind').notNull(),
  scopeId: uuid('scope_id'),
  scopeValue: text('scope_value'),
  priority: integer('priority').notNull().default(100),
});

export const promotions = pricing.table('promotions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code'),
  name: text('name').notNull(),
  description: text('description'),
  kind: text('kind').notNull(),
  rules: jsonb('rules').notNull(),
  priority: integer('priority').notNull().default(100),
  stackGroup: text('stack_group'),
  isExclusive: boolean('is_exclusive').notNull().default(false),
  requiresCoupon: boolean('requires_coupon').notNull().default(false),
  maxUsesTotal: integer('max_uses_total'),
  maxUsesPerCustomer: integer('max_uses_per_customer'),
  usesCount: integer('uses_count').notNull().default(0),
  budgetMinor: bigint('budget_minor', { mode: 'bigint' }),
  spentMinor: bigint('spent_minor', { mode: 'bigint' }).notNull().default(0n),
  schedule: jsonb('schedule').notNull().default({}),
  validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
  validTo: timestamp('valid_to', { withTimezone: true }),
  status: text('status').notNull().default('draft'),
  version: integer('version').notNull().default(1),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const promotionScopes = pricing.table('promotion_scopes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  promotionId: uuid('promotion_id').notNull(),
  scopeKind: text('scope_kind').notNull(),
  scopeId: uuid('scope_id'),
  scopeValue: text('scope_value'),
});

export const coupons = pricing.table('coupons', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  promotionId: uuid('promotion_id').notNull(),
  code: text('code').notNull(),
  customerId: uuid('customer_id'),
  maxUses: integer('max_uses').notNull().default(1),
  usesCount: integer('uses_count').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
