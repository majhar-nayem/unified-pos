import {
  bigint,
  boolean,
  char,
  customType,
  date,
  integer,
  jsonb,
  numeric,
  pgSchema,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** Postgres tsvector (full-text search); read as text, written by the migration 0003 triggers. */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
});

/** Drizzle mirror of db/schema_part2.sql (catalog) + migration 0003 columns. Identifiers + row types only; SQL stays explicit. */
export const catalogSchema = pgSchema('catalog');

export const taxClasses = catalogSchema.table('tax_classes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  // migration 0003
  version: integer('version').notNull().default(1),
});

export const categories = catalogSchema.table('categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  parentId: uuid('parent_id'),
  kind: text('kind').notNull(),
  code: text('code'),
  name: text('name').notNull(),
  path: text('path').notNull(),
  displayOrder: integer('display_order').notNull().default(0),
  imageUri: text('image_uri'),
  defaultTaxClassId: uuid('default_tax_class_id'),
  kitchenTags: text('kitchen_tags').array().notNull().default([]),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  // migration 0003
  version: integer('version').notNull().default(1),
});

export const items = catalogSchema.table('items', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  shortName: text('short_name'),
  description: text('description'),
  categoryId: uuid('category_id'),
  brandName: text('brand_name'),
  manufacturer: text('manufacturer'),
  taxClassId: uuid('tax_class_id'),
  soldBy: text('sold_by').notNull().default('unit'),
  unitOfMeasure: text('unit_of_measure').notNull().default('each'),
  trackInventory: boolean('track_inventory').notNull().default(true),
  isAgeRestricted: boolean('is_age_restricted').notNull().default(false),
  minAge: smallint('min_age'),
  images: jsonb('images').notNull().default([]),
  attributes: jsonb('attributes').notNull().default({}),
  allergens: text('allergens').array().notNull().default([]),
  dietaryTags: text('dietary_tags').array().notNull().default([]),
  kitchenTags: text('kitchen_tags').array().notNull().default([]),
  prepTimeSeconds: integer('prep_time_seconds'),
  searchVector: tsvector('search_vector'),
  status: text('status').notNull().default('active'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const itemVariants = catalogSchema.table('item_variants', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  itemId: uuid('item_id').notNull(),
  sku: text('sku'),
  name: text('name'),
  optionValues: jsonb('option_values').notNull().default({}),
  isDefault: boolean('is_default').notNull().default(false),
  defaultPriceMinor: bigint('default_price_minor', { mode: 'bigint' }),
  costMinor: bigint('cost_minor', { mode: 'bigint' }),
  weightGrams: integer('weight_grams'),
  dimensions: jsonb('dimensions'),
  trackSerials: boolean('track_serials').notNull().default(false),
  trackLots: boolean('track_lots').notNull().default(false),
  shelfLifeDays: integer('shelf_life_days'),
  status: text('status').notNull().default('active'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const barcodes = catalogSchema.table('barcodes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  code: text('code').notNull(),
  kind: text('kind').notNull().default('ean13'),
  packQuantity: numeric('pack_quantity', { precision: 14, scale: 4 }).notNull().default('1'),
  isPrimary: boolean('is_primary').notNull().default(false),
});

export const unitsOfMeasure = catalogSchema.table('units_of_measure', {
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  dimension: text('dimension').notNull(),
});

export const unitConversions = catalogSchema.table('unit_conversions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  variantId: uuid('variant_id'),
  fromUnit: text('from_unit').notNull(),
  toUnit: text('to_unit').notNull(),
  factor: numeric('factor', { precision: 18, scale: 8 }).notNull(),
});

export const itemComponents = catalogSchema.table('item_components', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  parentVariantId: uuid('parent_variant_id').notNull(),
  childVariantId: uuid('child_variant_id').notNull(),
  quantity: numeric('quantity', { precision: 14, scale: 4 }).notNull(),
  componentGroup: text('component_group'),
  isOptional: boolean('is_optional').notNull().default(false),
  priceDeltaMinor: bigint('price_delta_minor', { mode: 'bigint' }).notNull().default(0n),
  displayOrder: integer('display_order').notNull().default(0),
});

export const modifierGroups = catalogSchema.table('modifier_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  prompt: text('prompt'),
  selectionMin: smallint('selection_min').notNull().default(0),
  selectionMax: smallint('selection_max'),
  allowRepeat: boolean('allow_repeat').notNull().default(false),
  displayOrder: integer('display_order').notNull().default(0),
  status: text('status').notNull().default('active'),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const modifiers = catalogSchema.table('modifiers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  groupId: uuid('group_id').notNull(),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('add'),
  priceDeltaMinor: bigint('price_delta_minor', { mode: 'bigint' }).notNull().default(0n),
  linkedVariantId: uuid('linked_variant_id'),
  isDefault: boolean('is_default').notNull().default(false),
  maxQuantity: smallint('max_quantity').notNull().default(1),
  kitchenLabel: text('kitchen_label'),
  displayOrder: integer('display_order').notNull().default(0),
  status: text('status').notNull().default('active'),
});

export const itemModifierGroups = catalogSchema.table('item_modifier_groups', {
  tenantId: uuid('tenant_id').notNull(),
  itemId: uuid('item_id').notNull(),
  groupId: uuid('group_id').notNull(),
  displayOrder: integer('display_order').notNull().default(0),
  overrides: jsonb('overrides').notNull().default({}),
});

export const menus = catalogSchema.table('menus', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status').notNull().default('draft'),
  version: integer('version').notNull().default(1),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const menuSections = catalogSchema.table('menu_sections', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  menuId: uuid('menu_id').notNull(),
  parentSectionId: uuid('parent_section_id'),
  name: text('name').notNull(),
  displayOrder: integer('display_order').notNull().default(0),
  layout: jsonb('layout').notNull().default({}),
});

export const menuSectionItems = catalogSchema.table('menu_section_items', {
  tenantId: uuid('tenant_id').notNull(),
  sectionId: uuid('section_id').notNull(),
  itemId: uuid('item_id').notNull(),
  displayOrder: integer('display_order').notNull().default(0),
  priceOverrideMinor: bigint('price_override_minor', { mode: 'bigint' }),
  labelOverride: text('label_override'),
});

export const menuAssignments = catalogSchema.table('menu_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  menuId: uuid('menu_id').notNull(),
  scopeKind: text('scope_kind').notNull(),
  scopeId: uuid('scope_id').notNull(),
  channel: text('channel').notNull().default('all'),
  schedule: jsonb('schedule').notNull().default({}),
  validFrom: timestamp('valid_from', { withTimezone: true }),
  validTo: timestamp('valid_to', { withTimezone: true }),
  priority: integer('priority').notNull().default(100),
});

export const itemAvailability = catalogSchema.table('item_availability', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  locationId: uuid('location_id').notNull(),
  itemId: uuid('item_id'),
  variantId: uuid('variant_id'),
  isAvailable: boolean('is_available').notNull().default(true),
  snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
  reason: text('reason'),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const recipes = catalogSchema.table('recipes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  outputVariantId: uuid('output_variant_id').notNull(),
  version: integer('version').notNull().default(1),
  yieldQuantity: numeric('yield_quantity', { precision: 14, scale: 4 }).notNull().default('1'),
  yieldUnit: text('yield_unit').notNull().default('each'),
  consumeOn: text('consume_on').notNull().default('completed'),
  isActive: boolean('is_active').notNull().default(true),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const recipeLines = catalogSchema.table('recipe_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  recipeId: uuid('recipe_id').notNull(),
  ingredientVariantId: uuid('ingredient_variant_id').notNull(),
  quantity: numeric('quantity', { precision: 14, scale: 4 }).notNull(),
  unit: text('unit').notNull(),
  wasteFactor: numeric('waste_factor', { precision: 6, scale: 4 }).notNull().default('0'),
  isSubstitutable: boolean('is_substitutable').notNull().default(false),
});

export const modifierRecipeEffects = catalogSchema.table('modifier_recipe_effects', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  modifierId: uuid('modifier_id').notNull(),
  ingredientVariantId: uuid('ingredient_variant_id').notNull(),
  quantityDelta: numeric('quantity_delta', { precision: 14, scale: 4 }).notNull(),
  unit: text('unit').notNull(),
});

export const suppliers = catalogSchema.table('suppliers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code'),
  name: text('name').notNull(),
  contacts: jsonb('contacts').notNull().default([]),
  paymentTerms: text('payment_terms'),
  leadTimeDays: integer('lead_time_days'),
  minOrderMinor: bigint('min_order_minor', { mode: 'bigint' }),
  currency: char('currency', { length: 3 }),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  // migration 0003
  version: integer('version').notNull().default(1),
});

export const supplierItems = catalogSchema.table('supplier_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  supplierId: uuid('supplier_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  supplierSku: text('supplier_sku'),
  costMinor: bigint('cost_minor', { mode: 'bigint' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  packSize: numeric('pack_size', { precision: 14, scale: 4 }).notNull().default('1'),
  purchaseUnit: text('purchase_unit').notNull().default('each'),
  moq: numeric('moq', { precision: 14, scale: 4 }),
  leadTimeDays: integer('lead_time_days'),
  isPreferred: boolean('is_preferred').notNull().default(false),
  validFrom: date('valid_from'),
  validTo: date('valid_to'),
});

/** migration 0003 */
export const importJobs = catalogSchema.table('import_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  fileName: text('file_name').notNull(),
  status: text('status').notNull(),
  dryRun: boolean('dry_run').notNull().default(false),
  summary: jsonb('summary').notNull().default({}),
  errors: jsonb('errors').notNull().default([]),
  reportCsv: text('report_csv').notNull(),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
