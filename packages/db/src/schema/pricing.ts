import { boolean, char, date, integer, numeric, pgSchema, text, uuid } from 'drizzle-orm/pg-core';

/** Drizzle mirror of db/schema_part2.sql (pricing, F2 scope: tax rules) + migration 0003 columns. */
export const pricingSchema = pgSchema('pricing');

export const taxRules = pricingSchema.table('tax_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  jurisdictionCountry: char('jurisdiction_country', { length: 2 }).notNull(),
  jurisdictionRegion: text('jurisdiction_region'),
  taxClassId: uuid('tax_class_id'),
  kind: text('kind').notNull(),
  rate: numeric('rate', { precision: 9, scale: 6 }).notNull(),
  inclusiveDefault: boolean('inclusive_default').notNull().default(true),
  compound: boolean('compound').notNull().default(false),
  priority: integer('priority').notNull().default(100),
  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to'),
  // migration 0003
  version: integer('version').notNull().default(1),
});
