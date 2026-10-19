/**
 * Catalog DTOs for Phase 1 F2 (docs/03-implementation-plan.md §5 F2): categories, items,
 * variants, barcodes, units, components, modifiers, menus, availability, suppliers and the CSV
 * import. Enum values mirror the CHECK constraints in db/schema_part2.sql; jsonb columns have
 * their own schemas here so server, devices and admin validate the same shapes.
 */
import { z } from 'zod';

import {
  CursorQuerySchema,
  MinorAmountSchema,
  PositiveDecimalSchema,
  decimalString,
  isoInstant,
  pageOf,
  uuid,
} from './common.js';
import { CalendarDateSchema, CurrencyCodeSchema, TimeOfDaySchema } from './tenancy.js';

const code = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'letters, digits, _ . and - only');
const name = z.string().min(1).max(200);
const shortText = z.string().max(500);
const tag = z.string().min(1).max(64);
const tags = z.array(tag).max(50);
const displayOrder = z.number().int().min(-1_000_000).max(1_000_000);
const version = z.number().int().positive();

export const ACTIVE_ARCHIVED_STATUSES = ['active', 'archived'] as const;
const ActiveArchivedSchema = z.enum(ACTIVE_ARCHIVED_STATUSES);

// ---------------------------------------------------------------------------
// jsonb column schemas
// ---------------------------------------------------------------------------

/** catalog.items.images */
export const ItemImageSchema = z.object({
  uri: z.string().min(1).max(2048),
  alt: z.string().max(200).optional(),
  isPrimary: z.boolean().optional(),
});
export const ItemImagesSchema = z.array(ItemImageSchema).max(20);

/** catalog.items.attributes: option definitions ("size": ["S","M","L"]) and custom fields. */
export const ItemAttributeValueSchema = z.union([
  z.string().max(500),
  z.number(),
  z.boolean(),
  z.array(z.string().max(100)).max(100),
]);
export const ItemAttributesSchema = z.record(z.string().min(1).max(64), ItemAttributeValueSchema);
export type ItemAttributes = z.infer<typeof ItemAttributesSchema>;

/** catalog.item_variants.option_values: {"size":"L","colour":"red"} */
export const OptionValuesSchema = z.record(z.string().min(1).max(64), z.string().max(100));
export type OptionValues = z.infer<typeof OptionValuesSchema>;

/** catalog.item_variants.dimensions (millimetres). */
export const DimensionsSchema = z
  .object({
    lengthMm: z.number().nonnegative(),
    widthMm: z.number().nonnegative(),
    heightMm: z.number().nonnegative(),
  })
  .partial();

/** catalog.item_modifier_groups.overrides: per-item min/max/repeat and modifier price overrides. */
export const ModifierGroupOverridesSchema = z
  .object({
    selectionMin: z.number().int().min(0).max(100),
    selectionMax: z.number().int().min(0).max(100).nullable(),
    allowRepeat: z.boolean(),
    /** modifierId → price delta in minor units replacing the modifier's own delta. */
    modifierPrices: z.record(uuid, MinorAmountSchema),
  })
  .partial();
export type ModifierGroupOverrides = z.infer<typeof ModifierGroupOverridesSchema>;

/** catalog.menu_sections.layout */
export const MenuSectionLayoutSchema = z
  .object({
    colour: z.string().max(32),
    columns: z.number().int().min(1).max(12),
    icon: z.string().max(64),
  })
  .partial();

/**
 * catalog.menu_assignments.schedule: when the assignment is active in local time.
 * `days` are ISO weekdays (1 = Monday … 7 = Sunday); `windows` are half-open [from, to) and a
 * window whose `from` is later than its `to` spans midnight (22:00–02:00). Empty = always.
 */
export const MenuWindowSchema = z.object({ from: TimeOfDaySchema, to: TimeOfDaySchema });
export const MenuScheduleSchema = z
  .object({
    days: z.array(z.number().int().min(1).max(7)).max(7),
    windows: z.array(MenuWindowSchema).max(24),
  })
  .partial();
export type MenuSchedule = z.infer<typeof MenuScheduleSchema>;

/** catalog.suppliers.contacts */
export const SupplierContactSchema = z.object({
  name: z.string().max(200).optional(),
  role: z.string().max(100).optional(),
  email: z.string().email().max(254).optional(),
  phone: z.string().max(40).optional(),
});
export const SupplierContactsSchema = z.array(SupplierContactSchema).max(20);

// ---------------------------------------------------------------------------
// Categories (materialised path)
// ---------------------------------------------------------------------------

export const CATEGORY_KINDS = ['retail', 'menu', 'ingredient', 'service'] as const;
export const CategoryKindSchema = z.enum(CATEGORY_KINDS);

export const CategorySchema = z.object({
  id: uuid,
  tenantId: uuid,
  parentId: uuid.nullable(),
  kind: CategoryKindSchema,
  code: code.nullable(),
  name,
  /** "/food/burgers": slugs of the ancestors and this category. */
  path: z.string(),
  displayOrder,
  imageUri: z.string().max(2048).nullable(),
  defaultTaxClassId: uuid.nullable(),
  kitchenTags: tags,
  status: ActiveArchivedSchema,
  version,
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
export type CategoryDto = z.infer<typeof CategorySchema>;

export const CreateCategorySchema = z.object({
  parentId: uuid.nullable().optional(),
  kind: CategoryKindSchema,
  code: code.optional(),
  name,
  displayOrder: displayOrder.optional(),
  imageUri: z.string().max(2048).optional(),
  defaultTaxClassId: uuid.nullable().optional(),
  kitchenTags: tags.optional(),
});
export type CreateCategory = z.infer<typeof CreateCategorySchema>;

export const UpdateCategorySchema = z
  .object({
    parentId: uuid.nullable(),
    kind: CategoryKindSchema,
    code: code.nullable(),
    name,
    displayOrder,
    imageUri: z.string().max(2048).nullable(),
    defaultTaxClassId: uuid.nullable(),
    kitchenTags: tags,
    status: ActiveArchivedSchema,
  })
  .partial();
export type UpdateCategory = z.infer<typeof UpdateCategorySchema>;

export const CategoryListQuerySchema = CursorQuerySchema.extend({
  kind: CategoryKindSchema.optional(),
  status: ActiveArchivedSchema.optional(),
  parentId: uuid.optional(),
  /** Subtree: every category whose path starts with this one's path. */
  under: uuid.optional(),
});
export type CategoryListQuery = z.infer<typeof CategoryListQuerySchema>;
export const CategoryPageSchema = pageOf(CategorySchema);

// ---------------------------------------------------------------------------
// Units of measure
// ---------------------------------------------------------------------------

export const UNIT_DIMENSIONS = ['count', 'mass', 'volume', 'length'] as const;
export const UnitDimensionSchema = z.enum(UNIT_DIMENSIONS);
export const UnitCodeSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_]*$/, 'lowercase unit code');

export const UnitOfMeasureSchema = z.object({
  tenantId: uuid,
  code: UnitCodeSchema,
  name,
  dimension: UnitDimensionSchema,
});
export type UnitOfMeasureDto = z.infer<typeof UnitOfMeasureSchema>;
export const CreateUnitOfMeasureSchema = z.object({
  code: UnitCodeSchema,
  name,
  dimension: UnitDimensionSchema,
});
export type CreateUnitOfMeasure = z.infer<typeof CreateUnitOfMeasureSchema>;
export const UpdateUnitOfMeasureSchema = z
  .object({ name, dimension: UnitDimensionSchema })
  .partial();
export type UpdateUnitOfMeasure = z.infer<typeof UpdateUnitOfMeasureSchema>;

export const UnitConversionSchema = z.object({
  id: uuid,
  tenantId: uuid,
  /** null = generic conversion (kg → g) for every variant. */
  variantId: uuid.nullable(),
  fromUnit: UnitCodeSchema,
  toUnit: UnitCodeSchema,
  /** numeric(18,8): 1 fromUnit = factor toUnit. */
  factor: decimalString(8, 10),
});
export type UnitConversionDto = z.infer<typeof UnitConversionSchema>;
export const CreateUnitConversionSchema = z.object({
  variantId: uuid.nullable().optional(),
  fromUnit: UnitCodeSchema,
  toUnit: UnitCodeSchema,
  factor: decimalString(8, 10).refine((v) => Number(v) > 0, 'must be greater than zero'),
});
export type CreateUnitConversion = z.infer<typeof CreateUnitConversionSchema>;
export const UnitConversionListQuerySchema = CursorQuerySchema.extend({
  variantId: uuid.optional(),
});

// ---------------------------------------------------------------------------
// Items, variants, barcodes
// ---------------------------------------------------------------------------

export const ITEM_KINDS = [
  'product',
  'menu_item',
  'ingredient',
  'service',
  'gift_card',
  'fee',
  'combo',
] as const;
export const ItemKindSchema = z.enum(ITEM_KINDS);
export const SOLD_BY = ['unit', 'weight', 'volume', 'length'] as const;
export const SoldBySchema = z.enum(SOLD_BY);
export const ITEM_STATUSES = ['draft', 'active', 'discontinued', 'archived'] as const;
export const ItemStatusSchema = z.enum(ITEM_STATUSES);
export const VARIANT_STATUSES = ['active', 'discontinued', 'archived'] as const;
export const VariantStatusSchema = z.enum(VARIANT_STATUSES);
export const BARCODE_KINDS = [
  'ean13',
  'ean8',
  'upca',
  'upce',
  'code128',
  'code39',
  'qr',
  'plu',
  'internal',
  'gs1_databar',
] as const;
export const BarcodeKindSchema = z.enum(BARCODE_KINDS);
export const BarcodeCodeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'barcode characters');
export const SkuSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'SKU characters');

export const ItemSchema = z.object({
  id: uuid,
  tenantId: uuid,
  kind: ItemKindSchema,
  name,
  shortName: z.string().max(60).nullable(),
  description: z.string().max(4000).nullable(),
  categoryId: uuid.nullable(),
  brandName: z.string().max(200).nullable(),
  manufacturer: z.string().max(200).nullable(),
  taxClassId: uuid.nullable(),
  soldBy: SoldBySchema,
  unitOfMeasure: UnitCodeSchema,
  trackInventory: z.boolean(),
  isAgeRestricted: z.boolean(),
  minAge: z.number().int().min(0).max(150).nullable(),
  images: ItemImagesSchema,
  attributes: ItemAttributesSchema,
  allergens: tags,
  dietaryTags: tags,
  kitchenTags: tags,
  prepTimeSeconds: z.number().int().nonnegative().nullable(),
  status: ItemStatusSchema,
  version,
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
export type ItemDto = z.infer<typeof ItemSchema>;

export const BarcodeSchema = z.object({
  id: uuid,
  tenantId: uuid,
  variantId: uuid,
  code: BarcodeCodeSchema,
  kind: BarcodeKindSchema,
  /** numeric(14,4): units of the variant one scan represents (case barcodes). */
  packQuantity: PositiveDecimalSchema,
  isPrimary: z.boolean(),
});
export type BarcodeDto = z.infer<typeof BarcodeSchema>;

export const CreateBarcodeSchema = z.object({
  code: BarcodeCodeSchema,
  kind: BarcodeKindSchema.optional(),
  packQuantity: PositiveDecimalSchema.optional(),
  isPrimary: z.boolean().optional(),
});
export type CreateBarcode = z.infer<typeof CreateBarcodeSchema>;

export const VariantSchema = z.object({
  id: uuid,
  tenantId: uuid,
  itemId: uuid,
  sku: SkuSchema.nullable(),
  name: z.string().max(200).nullable(),
  optionValues: OptionValuesSchema,
  isDefault: z.boolean(),
  /** Fallback when no price list applies (F3). Minor units. */
  defaultPriceMinor: MinorAmountSchema.nullable(),
  costMinor: MinorAmountSchema.nullable(),
  weightGrams: z.number().int().nonnegative().nullable(),
  dimensions: DimensionsSchema.nullable(),
  trackSerials: z.boolean(),
  trackLots: z.boolean(),
  shelfLifeDays: z.number().int().nonnegative().nullable(),
  status: VariantStatusSchema,
  version,
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
export type VariantDto = z.infer<typeof VariantSchema>;

export const VariantWithBarcodesSchema = VariantSchema.extend({ barcodes: z.array(BarcodeSchema) });
export type VariantWithBarcodesDto = z.infer<typeof VariantWithBarcodesSchema>;

export const CreateVariantSchema = z.object({
  sku: SkuSchema.nullable().optional(),
  name: z.string().max(200).nullable().optional(),
  optionValues: OptionValuesSchema.optional(),
  isDefault: z.boolean().optional(),
  defaultPriceMinor: MinorAmountSchema.nullable().optional(),
  costMinor: MinorAmountSchema.nullable().optional(),
  weightGrams: z.number().int().nonnegative().nullable().optional(),
  dimensions: DimensionsSchema.nullable().optional(),
  trackSerials: z.boolean().optional(),
  trackLots: z.boolean().optional(),
  shelfLifeDays: z.number().int().nonnegative().nullable().optional(),
  barcodes: z.array(CreateBarcodeSchema).max(50).optional(),
});
export type CreateVariant = z.infer<typeof CreateVariantSchema>;

export const UpdateVariantSchema = z
  .object({
    sku: SkuSchema.nullable(),
    name: z.string().max(200).nullable(),
    optionValues: OptionValuesSchema,
    isDefault: z.boolean(),
    defaultPriceMinor: MinorAmountSchema.nullable(),
    costMinor: MinorAmountSchema.nullable(),
    weightGrams: z.number().int().nonnegative().nullable(),
    dimensions: DimensionsSchema.nullable(),
    trackSerials: z.boolean(),
    trackLots: z.boolean(),
    shelfLifeDays: z.number().int().nonnegative().nullable(),
    status: VariantStatusSchema,
  })
  .partial();
export type UpdateVariant = z.infer<typeof UpdateVariantSchema>;

export const CreateItemSchema = z.object({
  kind: ItemKindSchema,
  name,
  shortName: z.string().max(60).nullable().optional(),
  description: z.string().max(4000).nullable().optional(),
  categoryId: uuid.nullable().optional(),
  brandName: z.string().max(200).nullable().optional(),
  manufacturer: z.string().max(200).nullable().optional(),
  taxClassId: uuid.nullable().optional(),
  soldBy: SoldBySchema.optional(),
  unitOfMeasure: UnitCodeSchema.optional(),
  trackInventory: z.boolean().optional(),
  isAgeRestricted: z.boolean().optional(),
  minAge: z.number().int().min(0).max(150).nullable().optional(),
  images: ItemImagesSchema.optional(),
  attributes: ItemAttributesSchema.optional(),
  allergens: tags.optional(),
  dietaryTags: tags.optional(),
  kitchenTags: tags.optional(),
  prepTimeSeconds: z.number().int().nonnegative().nullable().optional(),
  status: ItemStatusSchema.optional(),
  /** Variants created with the item; the first one is the default unless another says so. */
  variants: z.array(CreateVariantSchema).max(200).optional(),
});
export type CreateItem = z.infer<typeof CreateItemSchema>;

export const UpdateItemSchema = z
  .object({
    kind: ItemKindSchema,
    name,
    shortName: z.string().max(60).nullable(),
    description: z.string().max(4000).nullable(),
    categoryId: uuid.nullable(),
    brandName: z.string().max(200).nullable(),
    manufacturer: z.string().max(200).nullable(),
    taxClassId: uuid.nullable(),
    soldBy: SoldBySchema,
    unitOfMeasure: UnitCodeSchema,
    trackInventory: z.boolean(),
    isAgeRestricted: z.boolean(),
    minAge: z.number().int().min(0).max(150).nullable(),
    images: ItemImagesSchema,
    attributes: ItemAttributesSchema,
    allergens: tags,
    dietaryTags: tags,
    kitchenTags: tags,
    prepTimeSeconds: z.number().int().nonnegative().nullable(),
    status: ItemStatusSchema,
  })
  .partial();
export type UpdateItem = z.infer<typeof UpdateItemSchema>;

export const ItemListQuerySchema = CursorQuerySchema.extend({
  kind: ItemKindSchema.optional(),
  status: ItemStatusSchema.optional(),
  categoryId: uuid.optional(),
});
export type ItemListQuery = z.infer<typeof ItemListQuerySchema>;
export const ItemPageSchema = pageOf(ItemSchema);

/** Item with its variants (and their barcodes) and modifier-group links. */
export const ItemModifierGroupLinkSchema = z.object({
  itemId: uuid,
  groupId: uuid,
  displayOrder,
  overrides: ModifierGroupOverridesSchema,
});
export type ItemModifierGroupLinkDto = z.infer<typeof ItemModifierGroupLinkSchema>;
export const ItemDetailSchema = ItemSchema.extend({
  variants: z.array(VariantWithBarcodesSchema),
  modifierGroups: z.array(ItemModifierGroupLinkSchema),
});
export type ItemDetailDto = z.infer<typeof ItemDetailSchema>;

export const ItemSearchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  kind: ItemKindSchema.optional(),
  status: ItemStatusSchema.optional(),
});
export type ItemSearchQuery = z.infer<typeof ItemSearchQuerySchema>;

export const ItemSearchHitSchema = z.object({
  item: ItemSchema,
  /** 0..1, combined full-text rank and trigram similarity. */
  score: z.number(),
  /** Which signal matched: full text, trigram, or both. */
  matchedBy: z.enum(['text', 'fuzzy', 'both']),
});
export const ItemSearchResultSchema = z.object({
  query: z.string(),
  hits: z.array(ItemSearchHitSchema),
});
export type ItemSearchResultDto = z.infer<typeof ItemSearchResultSchema>;

/** Scan lookup: variant + item + the barcode that matched (pack quantity for case codes). */
export const BarcodeLookupQuerySchema = z.object({ code: BarcodeCodeSchema });
export const SkuLookupQuerySchema = z.object({ sku: SkuSchema });
export const VariantLookupSchema = z.object({
  variant: VariantWithBarcodesSchema,
  item: ItemSchema,
  barcode: BarcodeSchema.nullable(),
});
export type VariantLookupDto = z.infer<typeof VariantLookupSchema>;

// ---------------------------------------------------------------------------
// Components (bundles, kits, combos)
// ---------------------------------------------------------------------------

export const ItemComponentSchema = z.object({
  id: uuid,
  tenantId: uuid,
  parentVariantId: uuid,
  childVariantId: uuid,
  quantity: PositiveDecimalSchema,
  /** "side", "drink": alternatives a combo lets the customer choose between. */
  componentGroup: z.string().max(64).nullable(),
  isOptional: z.boolean(),
  priceDeltaMinor: MinorAmountSchema,
  displayOrder,
});
export type ItemComponentDto = z.infer<typeof ItemComponentSchema>;
export const CreateItemComponentSchema = z.object({
  childVariantId: uuid,
  quantity: PositiveDecimalSchema.optional(),
  componentGroup: z.string().max(64).nullable().optional(),
  isOptional: z.boolean().optional(),
  priceDeltaMinor: MinorAmountSchema.optional(),
  displayOrder: displayOrder.optional(),
});
export type CreateItemComponent = z.infer<typeof CreateItemComponentSchema>;
export const UpdateItemComponentSchema = z
  .object({
    quantity: PositiveDecimalSchema,
    componentGroup: z.string().max(64).nullable(),
    isOptional: z.boolean(),
    priceDeltaMinor: MinorAmountSchema,
    displayOrder,
  })
  .partial();
export type UpdateItemComponent = z.infer<typeof UpdateItemComponentSchema>;

// ---------------------------------------------------------------------------
// Recipes (read-only stub until M10)
// ---------------------------------------------------------------------------

export const RecipeSchema = z.object({
  id: uuid,
  tenantId: uuid,
  outputVariantId: uuid,
  version,
  yieldQuantity: PositiveDecimalSchema,
  yieldUnit: z.string(),
  consumeOn: z.enum(['fired', 'completed', 'production']),
  isActive: z.boolean(),
  notes: z.string().nullable(),
  createdAt: isoInstant,
});
export type RecipeDto = z.infer<typeof RecipeSchema>;

// ---------------------------------------------------------------------------
// Modifier groups and modifiers
// ---------------------------------------------------------------------------

export const MODIFIER_KINDS = ['add', 'remove', 'substitute', 'instruction'] as const;
export const ModifierKindSchema = z.enum(MODIFIER_KINDS);

export const ModifierSchema = z.object({
  id: uuid,
  tenantId: uuid,
  groupId: uuid,
  name,
  kind: ModifierKindSchema,
  priceDeltaMinor: MinorAmountSchema,
  linkedVariantId: uuid.nullable(),
  isDefault: z.boolean(),
  maxQuantity: z.number().int().min(1).max(100),
  kitchenLabel: z.string().max(60).nullable(),
  displayOrder,
  status: ActiveArchivedSchema,
});
export type ModifierDto = z.infer<typeof ModifierSchema>;

export const CreateModifierSchema = z.object({
  name,
  kind: ModifierKindSchema.optional(),
  priceDeltaMinor: MinorAmountSchema.optional(),
  linkedVariantId: uuid.nullable().optional(),
  isDefault: z.boolean().optional(),
  maxQuantity: z.number().int().min(1).max(100).optional(),
  kitchenLabel: z.string().max(60).nullable().optional(),
  displayOrder: displayOrder.optional(),
});
export type CreateModifier = z.infer<typeof CreateModifierSchema>;
export const UpdateModifierSchema = z
  .object({
    name,
    kind: ModifierKindSchema,
    priceDeltaMinor: MinorAmountSchema,
    linkedVariantId: uuid.nullable(),
    isDefault: z.boolean(),
    maxQuantity: z.number().int().min(1).max(100),
    kitchenLabel: z.string().max(60).nullable(),
    displayOrder,
    status: ActiveArchivedSchema,
  })
  .partial();
export type UpdateModifier = z.infer<typeof UpdateModifierSchema>;

export const ModifierGroupSchema = z.object({
  id: uuid,
  tenantId: uuid,
  name,
  prompt: z.string().max(200).nullable(),
  selectionMin: z.number().int().min(0),
  selectionMax: z.number().int().min(0).nullable(),
  allowRepeat: z.boolean(),
  displayOrder,
  status: ActiveArchivedSchema,
  version,
  updatedAt: isoInstant,
});
export type ModifierGroupDto = z.infer<typeof ModifierGroupSchema>;
export const ModifierGroupDetailSchema = ModifierGroupSchema.extend({
  modifiers: z.array(ModifierSchema),
});
export type ModifierGroupDetailDto = z.infer<typeof ModifierGroupDetailSchema>;

const selectionBounds = <T extends { selectionMin?: number; selectionMax?: number | null }>(v: T) =>
  v.selectionMax === undefined ||
  v.selectionMax === null ||
  v.selectionMin === undefined ||
  v.selectionMax >= v.selectionMin;

export const CreateModifierGroupSchema = z
  .object({
    name,
    prompt: z.string().max(200).nullable().optional(),
    selectionMin: z.number().int().min(0).max(100).optional(),
    selectionMax: z.number().int().min(0).max(100).nullable().optional(),
    allowRepeat: z.boolean().optional(),
    displayOrder: displayOrder.optional(),
    modifiers: z.array(CreateModifierSchema).max(100).optional(),
  })
  .refine(selectionBounds, {
    message: 'selectionMax must be >= selectionMin',
    path: ['selectionMax'],
  });
export type CreateModifierGroup = z.infer<typeof CreateModifierGroupSchema>;
export const UpdateModifierGroupSchema = z
  .object({
    name,
    prompt: z.string().max(200).nullable(),
    selectionMin: z.number().int().min(0).max(100),
    selectionMax: z.number().int().min(0).max(100).nullable(),
    allowRepeat: z.boolean(),
    displayOrder,
    status: ActiveArchivedSchema,
  })
  .partial()
  .refine(selectionBounds, {
    message: 'selectionMax must be >= selectionMin',
    path: ['selectionMax'],
  });
export type UpdateModifierGroup = z.infer<typeof UpdateModifierGroupSchema>;
export const ModifierGroupListQuerySchema = CursorQuerySchema.extend({
  status: ActiveArchivedSchema.optional(),
});
export const ModifierGroupPageSchema = pageOf(ModifierGroupSchema);

export const LinkModifierGroupSchema = z.object({
  displayOrder: displayOrder.optional(),
  overrides: ModifierGroupOverridesSchema.optional(),
});
export type LinkModifierGroup = z.infer<typeof LinkModifierGroupSchema>;

/** Validate a customer's modifier picks for an item (POS and online ordering share this). */
export const ModifierSelectionSchema = z.object({
  groupId: uuid,
  modifierId: uuid,
  quantity: z.number().int().min(1).max(100).default(1),
});
export type ModifierSelection = z.infer<typeof ModifierSelectionSchema>;
export const ValidateModifierSelectionSchema = z.object({
  selections: z.array(ModifierSelectionSchema).max(200),
});
export type ValidateModifierSelection = z.infer<typeof ValidateModifierSelectionSchema>;

export const MODIFIER_ISSUE_CODES = [
  'GROUP_NOT_LINKED',
  'GROUP_ARCHIVED',
  'GROUP_BELOW_MIN',
  'GROUP_ABOVE_MAX',
  'MODIFIER_UNKNOWN',
  'MODIFIER_NOT_IN_GROUP',
  'MODIFIER_ARCHIVED',
  'REPEAT_NOT_ALLOWED',
  'QUANTITY_ABOVE_MAX',
] as const;
export const ModifierIssueSchema = z.object({
  code: z.enum(MODIFIER_ISSUE_CODES),
  groupId: uuid.nullable(),
  modifierId: uuid.nullable(),
  message: z.string(),
});
export type ModifierIssueDto = z.infer<typeof ModifierIssueSchema>;
export const ModifierValidationSchema = z.object({
  valid: z.boolean(),
  issues: z.array(ModifierIssueSchema),
  /** Σ (effective price delta × quantity) over accepted selections, minor units. */
  priceDeltaMinor: MinorAmountSchema,
  selections: z.array(
    z.object({
      groupId: uuid,
      modifierId: uuid,
      quantity: z.number().int(),
      unitPriceDeltaMinor: MinorAmountSchema,
    }),
  ),
});
export type ModifierValidationDto = z.infer<typeof ModifierValidationSchema>;

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

export const MENU_STATUSES = ['draft', 'published', 'archived'] as const;
export const MenuStatusSchema = z.enum(MENU_STATUSES);
export const MENU_CHANNELS = [
  'all',
  'dine_in',
  'takeaway',
  'delivery',
  'online',
  'kiosk',
  'qr',
  'drive_through',
] as const;
export const MenuChannelSchema = z.enum(MENU_CHANNELS);
/** A concrete channel a request comes from (never `all`). */
export const OrderChannelSchema = z.enum(
  MENU_CHANNELS.filter((c) => c !== 'all') as [string, ...string[]],
);
export const MENU_SCOPE_KINDS = ['tenant', 'org_unit', 'location', 'register'] as const;
export const MenuScopeKindSchema = z.enum(MENU_SCOPE_KINDS);

export const MenuSchema = z.object({
  id: uuid,
  tenantId: uuid,
  name,
  description: shortText.nullable(),
  status: MenuStatusSchema,
  /** Bumped on publish; devices pull by version. */
  version,
  publishedAt: isoInstant.nullable(),
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
export type MenuDto = z.infer<typeof MenuSchema>;
export const CreateMenuSchema = z.object({ name, description: shortText.nullable().optional() });
export type CreateMenu = z.infer<typeof CreateMenuSchema>;
export const UpdateMenuSchema = z
  .object({ name, description: shortText.nullable(), status: z.enum(['draft', 'archived']) })
  .partial();
export type UpdateMenu = z.infer<typeof UpdateMenuSchema>;
export const MenuListQuerySchema = CursorQuerySchema.extend({
  status: MenuStatusSchema.optional(),
});
export const MenuPageSchema = pageOf(MenuSchema);

export const MenuSectionItemSchema = z.object({
  sectionId: uuid,
  itemId: uuid,
  displayOrder,
  priceOverrideMinor: MinorAmountSchema.nullable(),
  labelOverride: z.string().max(60).nullable(),
});
export type MenuSectionItemDto = z.infer<typeof MenuSectionItemSchema>;
export const PutMenuSectionItemSchema = z.object({
  displayOrder: displayOrder.optional(),
  priceOverrideMinor: MinorAmountSchema.nullable().optional(),
  labelOverride: z.string().max(60).nullable().optional(),
});
export type PutMenuSectionItem = z.infer<typeof PutMenuSectionItemSchema>;

export const MenuSectionSchema = z.object({
  id: uuid,
  tenantId: uuid,
  menuId: uuid,
  parentSectionId: uuid.nullable(),
  name,
  displayOrder,
  layout: MenuSectionLayoutSchema,
});
export type MenuSectionDto = z.infer<typeof MenuSectionSchema>;
export const CreateMenuSectionSchema = z.object({
  parentSectionId: uuid.nullable().optional(),
  name,
  displayOrder: displayOrder.optional(),
  layout: MenuSectionLayoutSchema.optional(),
});
export type CreateMenuSection = z.infer<typeof CreateMenuSectionSchema>;
export const UpdateMenuSectionSchema = z
  .object({ parentSectionId: uuid.nullable(), name, displayOrder, layout: MenuSectionLayoutSchema })
  .partial();
export type UpdateMenuSection = z.infer<typeof UpdateMenuSectionSchema>;

export const MenuSectionTreeSchema = MenuSectionSchema.extend({
  items: z.array(MenuSectionItemSchema),
});
export const MenuTreeSchema = MenuSchema.extend({ sections: z.array(MenuSectionTreeSchema) });
export type MenuTreeDto = z.infer<typeof MenuTreeSchema>;

export const MenuAssignmentSchema = z.object({
  id: uuid,
  tenantId: uuid,
  menuId: uuid,
  scopeKind: MenuScopeKindSchema,
  scopeId: uuid,
  channel: MenuChannelSchema,
  schedule: MenuScheduleSchema,
  validFrom: isoInstant.nullable(),
  validTo: isoInstant.nullable(),
  /** Higher wins. */
  priority: z.number().int(),
});
export type MenuAssignmentDto = z.infer<typeof MenuAssignmentSchema>;
export const CreateMenuAssignmentSchema = z.object({
  scopeKind: MenuScopeKindSchema,
  scopeId: uuid,
  channel: MenuChannelSchema.optional(),
  schedule: MenuScheduleSchema.optional(),
  validFrom: isoInstant.nullable().optional(),
  validTo: isoInstant.nullable().optional(),
  priority: z.number().int().min(-1_000_000).max(1_000_000).optional(),
});
export type CreateMenuAssignment = z.infer<typeof CreateMenuAssignmentSchema>;
export const UpdateMenuAssignmentSchema = z
  .object({
    scopeKind: MenuScopeKindSchema,
    scopeId: uuid,
    channel: MenuChannelSchema,
    schedule: MenuScheduleSchema,
    validFrom: isoInstant.nullable(),
    validTo: isoInstant.nullable(),
    priority: z.number().int().min(-1_000_000).max(1_000_000),
  })
  .partial();
export type UpdateMenuAssignment = z.infer<typeof UpdateMenuAssignmentSchema>;

/** Which menu applies at a location (optionally a register) for a channel at an instant. */
export const MenuResolveQuerySchema = z.object({
  locationId: uuid,
  registerId: uuid.optional(),
  channel: OrderChannelSchema,
  /** Instant; defaults to now. Converted to the location's local time. */
  at: isoInstant.optional(),
});
export type MenuResolveQuery = z.infer<typeof MenuResolveQuerySchema>;
export const MenuResolutionSchema = z.object({
  locationId: uuid,
  channel: OrderChannelSchema,
  at: isoInstant,
  timezone: z.string(),
  localDate: CalendarDateSchema,
  localTime: TimeOfDaySchema,
  /** ISO weekday 1 = Monday … 7 = Sunday. */
  weekday: z.number().int().min(1).max(7),
  assignment: MenuAssignmentSchema.nullable(),
  menu: MenuTreeSchema.nullable(),
  candidates: z.number().int().nonnegative(),
});
export type MenuResolutionDto = z.infer<typeof MenuResolutionSchema>;

// ---------------------------------------------------------------------------
// Availability (86 list)
// ---------------------------------------------------------------------------

export const ItemAvailabilitySchema = z.object({
  id: uuid,
  tenantId: uuid,
  locationId: uuid,
  itemId: uuid.nullable(),
  variantId: uuid.nullable(),
  isAvailable: z.boolean(),
  snoozedUntil: isoInstant.nullable(),
  reason: z.string().max(200).nullable(),
  updatedBy: uuid.nullable(),
  updatedAt: isoInstant,
});
export type ItemAvailabilityDto = z.infer<typeof ItemAvailabilitySchema>;
export const PutItemAvailabilitySchema = z
  .object({
    itemId: uuid.optional(),
    variantId: uuid.optional(),
    isAvailable: z.boolean(),
    /** Automatically available again after this instant (device-side); null = until changed. */
    snoozedUntil: isoInstant.nullable().optional(),
    reason: z.string().max(200).nullable().optional(),
  })
  .refine((v) => Boolean(v.itemId) !== Boolean(v.variantId), {
    message: 'exactly one of itemId or variantId',
    path: ['itemId'],
  });
export type PutItemAvailability = z.infer<typeof PutItemAvailabilitySchema>;
export const AvailabilityListQuerySchema = CursorQuerySchema.extend({
  onlyUnavailable: z.coerce.boolean().optional(),
});
export const ItemAvailabilityPageSchema = pageOf(ItemAvailabilitySchema);

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export const SupplierSchema = z.object({
  id: uuid,
  tenantId: uuid,
  code: code.nullable(),
  name,
  contacts: SupplierContactsSchema,
  paymentTerms: z.string().max(200).nullable(),
  leadTimeDays: z.number().int().nonnegative().nullable(),
  minOrderMinor: MinorAmountSchema.nullable(),
  currency: CurrencyCodeSchema.nullable(),
  status: ActiveArchivedSchema,
  version,
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
export type SupplierDto = z.infer<typeof SupplierSchema>;
export const CreateSupplierSchema = z.object({
  code: code.nullable().optional(),
  name,
  contacts: SupplierContactsSchema.optional(),
  paymentTerms: z.string().max(200).nullable().optional(),
  leadTimeDays: z.number().int().nonnegative().nullable().optional(),
  minOrderMinor: MinorAmountSchema.nullable().optional(),
  currency: CurrencyCodeSchema.nullable().optional(),
});
export type CreateSupplier = z.infer<typeof CreateSupplierSchema>;
export const UpdateSupplierSchema = z
  .object({
    code: code.nullable(),
    name,
    contacts: SupplierContactsSchema,
    paymentTerms: z.string().max(200).nullable(),
    leadTimeDays: z.number().int().nonnegative().nullable(),
    minOrderMinor: MinorAmountSchema.nullable(),
    currency: CurrencyCodeSchema.nullable(),
    status: ActiveArchivedSchema,
  })
  .partial();
export type UpdateSupplier = z.infer<typeof UpdateSupplierSchema>;
export const SupplierListQuerySchema = CursorQuerySchema.extend({
  status: ActiveArchivedSchema.optional(),
});
export const SupplierPageSchema = pageOf(SupplierSchema);

export const SupplierItemSchema = z.object({
  id: uuid,
  tenantId: uuid,
  supplierId: uuid,
  variantId: uuid,
  supplierSku: z.string().max(64).nullable(),
  costMinor: MinorAmountSchema,
  currency: CurrencyCodeSchema,
  packSize: PositiveDecimalSchema,
  purchaseUnit: UnitCodeSchema,
  moq: PositiveDecimalSchema.nullable(),
  leadTimeDays: z.number().int().nonnegative().nullable(),
  isPreferred: z.boolean(),
  validFrom: CalendarDateSchema.nullable(),
  validTo: CalendarDateSchema.nullable(),
});
export type SupplierItemDto = z.infer<typeof SupplierItemSchema>;
export const CreateSupplierItemSchema = z.object({
  variantId: uuid,
  supplierSku: z.string().max(64).nullable().optional(),
  costMinor: MinorAmountSchema,
  currency: CurrencyCodeSchema,
  packSize: PositiveDecimalSchema.optional(),
  purchaseUnit: UnitCodeSchema.optional(),
  moq: PositiveDecimalSchema.nullable().optional(),
  leadTimeDays: z.number().int().nonnegative().nullable().optional(),
  isPreferred: z.boolean().optional(),
  validFrom: CalendarDateSchema.nullable().optional(),
  validTo: CalendarDateSchema.nullable().optional(),
});
export type CreateSupplierItem = z.infer<typeof CreateSupplierItemSchema>;
export const UpdateSupplierItemSchema = z
  .object({
    supplierSku: z.string().max(64).nullable(),
    costMinor: MinorAmountSchema,
    currency: CurrencyCodeSchema,
    packSize: PositiveDecimalSchema,
    purchaseUnit: UnitCodeSchema,
    moq: PositiveDecimalSchema.nullable(),
    leadTimeDays: z.number().int().nonnegative().nullable(),
    isPreferred: z.boolean(),
    validFrom: CalendarDateSchema.nullable(),
    validTo: CalendarDateSchema.nullable(),
  })
  .partial();
export type UpdateSupplierItem = z.infer<typeof UpdateSupplierItemSchema>;

// ---------------------------------------------------------------------------
// CSV import (items / variants / barcodes)
// ---------------------------------------------------------------------------

/** Columns of the import file, in header order. Unknown columns are reported, not ignored. */
export const CATALOG_IMPORT_COLUMNS = [
  'item_ref',
  'item_name',
  'item_kind',
  'category_code',
  'tax_class_code',
  'sold_by',
  'unit',
  'sku',
  'variant_name',
  'option_values',
  'price',
  'cost',
  'barcode',
  'barcode_kind',
  'pack_quantity',
  'track_inventory',
] as const;
export type CatalogImportColumn = (typeof CATALOG_IMPORT_COLUMNS)[number];

export const CATALOG_IMPORT_STATUSES = ['validated', 'applied', 'rejected'] as const;
export const CatalogImportStatusSchema = z.enum(CATALOG_IMPORT_STATUSES);

export const CATALOG_IMPORT_ERROR_CODES = [
  'MISSING_HEADER',
  'UNKNOWN_COLUMN',
  'MISSING_ITEM_NAME',
  'INVALID_ITEM_KIND',
  'INVALID_SOLD_BY',
  'UNKNOWN_CATEGORY',
  'UNKNOWN_TAX_CLASS',
  'UNKNOWN_UNIT',
  'INVALID_SKU',
  'DUPLICATE_SKU',
  'INVALID_PRICE',
  'INVALID_COST',
  'INVALID_OPTION_VALUES',
  'INVALID_BARCODE',
  'INVALID_BARCODE_KIND',
  'DUPLICATE_BARCODE',
  'BARCODE_IN_USE',
  'INVALID_PACK_QUANTITY',
  'INVALID_TRACK_INVENTORY',
  'ITEM_CONFLICT',
  'EMPTY_FILE',
] as const;
export const CatalogImportErrorSchema = z.object({
  /** 1-based line number in the file (the header is line 1). */
  line: z.number().int().positive(),
  column: z.string().nullable(),
  code: z.enum(CATALOG_IMPORT_ERROR_CODES),
  message: z.string(),
});
export type CatalogImportErrorDto = z.infer<typeof CatalogImportErrorSchema>;

export const CatalogImportSummarySchema = z.object({
  rows: z.number().int().nonnegative(),
  items: z.number().int().nonnegative(),
  variants: z.number().int().nonnegative(),
  barcodes: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
});

export const CreateCatalogImportSchema = z.object({
  fileName: z.string().max(200).optional(),
  /** The CSV text (UTF-8, RFC 4180, header row required). Up to 5 MB. */
  content: z
    .string()
    .min(1)
    .max(5 * 1024 * 1024),
  /** Validate only: never writes catalog rows, still records the job and report. */
  dryRun: z.boolean().optional(),
});
export type CreateCatalogImport = z.infer<typeof CreateCatalogImportSchema>;

export const CatalogImportSchema = z.object({
  id: uuid,
  tenantId: uuid,
  fileName: z.string(),
  status: CatalogImportStatusSchema,
  dryRun: z.boolean(),
  summary: CatalogImportSummarySchema,
  errors: z.array(CatalogImportErrorSchema),
  /** `GET /v1/catalog/imports/{id}/report` serves the CSV validation report. */
  reportUrl: z.string(),
  createdBy: uuid.nullable(),
  createdAt: isoInstant,
});
export type CatalogImportDto = z.infer<typeof CatalogImportSchema>;
