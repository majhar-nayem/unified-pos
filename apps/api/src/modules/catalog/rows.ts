import type {
  BarcodeDto,
  CatalogImportDto,
  CategoryDto,
  ItemAvailabilityDto,
  ItemComponentDto,
  ItemDto,
  ItemModifierGroupLinkDto,
  MenuAssignmentDto,
  MenuDto,
  MenuSectionDto,
  MenuSectionItemDto,
  ModifierDto,
  ModifierGroupDto,
  RecipeDto,
  SupplierDto,
  SupplierItemDto,
  TaxClassDto,
  UnitConversionDto,
  UnitOfMeasureDto,
  VariantDto,
} from '@pos/contracts';

import { calendarDate, iso, isoOrNull, minor, minorRequired } from './shared/sql.js';

/** Row shapes (snake_case, as pg returns them: int8 → bigint, numeric/date → string) and DTO mappers. */

export interface TaxClassRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  version: number;
}
export const toTaxClassDto = (r: TaxClassRow): TaxClassDto => ({
  id: r.id,
  tenantId: r.tenant_id,
  code: r.code,
  name: r.name,
  version: r.version,
});

export interface CategoryRow {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  kind: CategoryDto['kind'];
  code: string | null;
  name: string;
  path: string;
  display_order: number;
  image_uri: string | null;
  default_tax_class_id: string | null;
  kitchen_tags: string[];
  status: CategoryDto['status'];
  version: number;
  created_at: Date;
  updated_at: Date;
}
export const toCategoryDto = (r: CategoryRow): CategoryDto => ({
  id: r.id,
  tenantId: r.tenant_id,
  parentId: r.parent_id,
  kind: r.kind,
  code: r.code,
  name: r.name,
  path: r.path,
  displayOrder: r.display_order,
  imageUri: r.image_uri,
  defaultTaxClassId: r.default_tax_class_id,
  kitchenTags: r.kitchen_tags ?? [],
  status: r.status,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export interface UnitRow {
  tenant_id: string;
  code: string;
  name: string;
  dimension: UnitOfMeasureDto['dimension'];
}
export const toUnitDto = (r: UnitRow): UnitOfMeasureDto => ({
  tenantId: r.tenant_id,
  code: r.code,
  name: r.name,
  dimension: r.dimension,
});

export interface UnitConversionRow {
  id: string;
  tenant_id: string;
  variant_id: string | null;
  from_unit: string;
  to_unit: string;
  factor: string;
}
export const toUnitConversionDto = (r: UnitConversionRow): UnitConversionDto => ({
  id: r.id,
  tenantId: r.tenant_id,
  variantId: r.variant_id,
  fromUnit: r.from_unit,
  toUnit: r.to_unit,
  factor: r.factor,
});

export interface ItemRow {
  id: string;
  tenant_id: string;
  kind: ItemDto['kind'];
  name: string;
  short_name: string | null;
  description: string | null;
  category_id: string | null;
  brand_name: string | null;
  manufacturer: string | null;
  tax_class_id: string | null;
  sold_by: ItemDto['soldBy'];
  unit_of_measure: string;
  track_inventory: boolean;
  is_age_restricted: boolean;
  min_age: number | null;
  images: ItemDto['images'];
  attributes: ItemDto['attributes'];
  allergens: string[];
  dietary_tags: string[];
  kitchen_tags: string[];
  prep_time_seconds: number | null;
  status: ItemDto['status'];
  version: number;
  created_at: Date;
  updated_at: Date;
}
export const toItemDto = (r: ItemRow): ItemDto => ({
  id: r.id,
  tenantId: r.tenant_id,
  kind: r.kind,
  name: r.name,
  shortName: r.short_name,
  description: r.description,
  categoryId: r.category_id,
  brandName: r.brand_name,
  manufacturer: r.manufacturer,
  taxClassId: r.tax_class_id,
  soldBy: r.sold_by,
  unitOfMeasure: r.unit_of_measure,
  trackInventory: r.track_inventory,
  isAgeRestricted: r.is_age_restricted,
  minAge: r.min_age,
  images: r.images ?? [],
  attributes: r.attributes ?? {},
  allergens: r.allergens ?? [],
  dietaryTags: r.dietary_tags ?? [],
  kitchenTags: r.kitchen_tags ?? [],
  prepTimeSeconds: r.prep_time_seconds,
  status: r.status,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export interface VariantRow {
  id: string;
  tenant_id: string;
  item_id: string;
  sku: string | null;
  name: string | null;
  option_values: VariantDto['optionValues'];
  is_default: boolean;
  default_price_minor: bigint | null;
  cost_minor: bigint | null;
  weight_grams: number | null;
  dimensions: VariantDto['dimensions'];
  track_serials: boolean;
  track_lots: boolean;
  shelf_life_days: number | null;
  status: VariantDto['status'];
  version: number;
  created_at: Date;
  updated_at: Date;
}
export const toVariantDto = (r: VariantRow): VariantDto => ({
  id: r.id,
  tenantId: r.tenant_id,
  itemId: r.item_id,
  sku: r.sku,
  name: r.name,
  optionValues: r.option_values ?? {},
  isDefault: r.is_default,
  defaultPriceMinor: minor(r.default_price_minor),
  costMinor: minor(r.cost_minor),
  weightGrams: r.weight_grams,
  dimensions: r.dimensions ?? null,
  trackSerials: r.track_serials,
  trackLots: r.track_lots,
  shelfLifeDays: r.shelf_life_days,
  status: r.status,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export interface BarcodeRow {
  id: string;
  tenant_id: string;
  variant_id: string;
  code: string;
  kind: BarcodeDto['kind'];
  pack_quantity: string;
  is_primary: boolean;
}
export const toBarcodeDto = (r: BarcodeRow): BarcodeDto => ({
  id: r.id,
  tenantId: r.tenant_id,
  variantId: r.variant_id,
  code: r.code,
  kind: r.kind,
  packQuantity: r.pack_quantity,
  isPrimary: r.is_primary,
});

export interface ComponentRow {
  id: string;
  tenant_id: string;
  parent_variant_id: string;
  child_variant_id: string;
  quantity: string;
  component_group: string | null;
  is_optional: boolean;
  price_delta_minor: bigint;
  display_order: number;
}
export const toComponentDto = (r: ComponentRow): ItemComponentDto => ({
  id: r.id,
  tenantId: r.tenant_id,
  parentVariantId: r.parent_variant_id,
  childVariantId: r.child_variant_id,
  quantity: r.quantity,
  componentGroup: r.component_group,
  isOptional: r.is_optional,
  priceDeltaMinor: minorRequired(r.price_delta_minor),
  displayOrder: r.display_order,
});

export interface RecipeRow {
  id: string;
  tenant_id: string;
  output_variant_id: string;
  version: number;
  yield_quantity: string;
  yield_unit: string;
  consume_on: RecipeDto['consumeOn'];
  is_active: boolean;
  notes: string | null;
  created_at: Date;
}
export const toRecipeDto = (r: RecipeRow): RecipeDto => ({
  id: r.id,
  tenantId: r.tenant_id,
  outputVariantId: r.output_variant_id,
  version: r.version,
  yieldQuantity: r.yield_quantity,
  yieldUnit: r.yield_unit,
  consumeOn: r.consume_on,
  isActive: r.is_active,
  notes: r.notes,
  createdAt: iso(r.created_at),
});

export interface ModifierGroupRow {
  id: string;
  tenant_id: string;
  name: string;
  prompt: string | null;
  selection_min: number;
  selection_max: number | null;
  allow_repeat: boolean;
  display_order: number;
  status: ModifierGroupDto['status'];
  version: number;
  updated_at: Date;
}
export const toModifierGroupDto = (r: ModifierGroupRow): ModifierGroupDto => ({
  id: r.id,
  tenantId: r.tenant_id,
  name: r.name,
  prompt: r.prompt,
  selectionMin: r.selection_min,
  selectionMax: r.selection_max,
  allowRepeat: r.allow_repeat,
  displayOrder: r.display_order,
  status: r.status,
  version: r.version,
  updatedAt: iso(r.updated_at),
});

export interface ModifierRow {
  id: string;
  tenant_id: string;
  group_id: string;
  name: string;
  kind: ModifierDto['kind'];
  price_delta_minor: bigint;
  linked_variant_id: string | null;
  is_default: boolean;
  max_quantity: number;
  kitchen_label: string | null;
  display_order: number;
  status: ModifierDto['status'];
}
export const toModifierDto = (r: ModifierRow): ModifierDto => ({
  id: r.id,
  tenantId: r.tenant_id,
  groupId: r.group_id,
  name: r.name,
  kind: r.kind,
  priceDeltaMinor: minorRequired(r.price_delta_minor),
  linkedVariantId: r.linked_variant_id,
  isDefault: r.is_default,
  maxQuantity: r.max_quantity,
  kitchenLabel: r.kitchen_label,
  displayOrder: r.display_order,
  status: r.status,
});

export interface ItemModifierGroupRow {
  tenant_id: string;
  item_id: string;
  group_id: string;
  display_order: number;
  overrides: ItemModifierGroupLinkDto['overrides'];
}
export const toItemModifierGroupDto = (r: ItemModifierGroupRow): ItemModifierGroupLinkDto => ({
  itemId: r.item_id,
  groupId: r.group_id,
  displayOrder: r.display_order,
  overrides: r.overrides ?? {},
});

export interface MenuRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  status: MenuDto['status'];
  version: number;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
export const toMenuDto = (r: MenuRow): MenuDto => ({
  id: r.id,
  tenantId: r.tenant_id,
  name: r.name,
  description: r.description,
  status: r.status,
  version: r.version,
  publishedAt: isoOrNull(r.published_at),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export interface MenuSectionRow {
  id: string;
  tenant_id: string;
  menu_id: string;
  parent_section_id: string | null;
  name: string;
  display_order: number;
  layout: MenuSectionDto['layout'];
}
export const toMenuSectionDto = (r: MenuSectionRow): MenuSectionDto => ({
  id: r.id,
  tenantId: r.tenant_id,
  menuId: r.menu_id,
  parentSectionId: r.parent_section_id,
  name: r.name,
  displayOrder: r.display_order,
  layout: r.layout ?? {},
});

export interface MenuSectionItemRow {
  tenant_id: string;
  section_id: string;
  item_id: string;
  display_order: number;
  price_override_minor: bigint | null;
  label_override: string | null;
}
export const toMenuSectionItemDto = (r: MenuSectionItemRow): MenuSectionItemDto => ({
  sectionId: r.section_id,
  itemId: r.item_id,
  displayOrder: r.display_order,
  priceOverrideMinor: minor(r.price_override_minor),
  labelOverride: r.label_override,
});

export interface MenuAssignmentRow {
  id: string;
  tenant_id: string;
  menu_id: string;
  scope_kind: MenuAssignmentDto['scopeKind'];
  scope_id: string;
  channel: MenuAssignmentDto['channel'];
  schedule: MenuAssignmentDto['schedule'];
  valid_from: Date | null;
  valid_to: Date | null;
  priority: number;
}
export const toMenuAssignmentDto = (r: MenuAssignmentRow): MenuAssignmentDto => ({
  id: r.id,
  tenantId: r.tenant_id,
  menuId: r.menu_id,
  scopeKind: r.scope_kind,
  scopeId: r.scope_id,
  channel: r.channel,
  schedule: r.schedule ?? {},
  validFrom: isoOrNull(r.valid_from),
  validTo: isoOrNull(r.valid_to),
  priority: r.priority,
});

export interface AvailabilityRow {
  id: string;
  tenant_id: string;
  location_id: string;
  item_id: string | null;
  variant_id: string | null;
  is_available: boolean;
  snoozed_until: Date | null;
  reason: string | null;
  updated_by: string | null;
  updated_at: Date;
}
export const toAvailabilityDto = (r: AvailabilityRow): ItemAvailabilityDto => ({
  id: r.id,
  tenantId: r.tenant_id,
  locationId: r.location_id,
  itemId: r.item_id,
  variantId: r.variant_id,
  isAvailable: r.is_available,
  snoozedUntil: isoOrNull(r.snoozed_until),
  reason: r.reason,
  updatedBy: r.updated_by,
  updatedAt: iso(r.updated_at),
});

export interface SupplierRow {
  id: string;
  tenant_id: string;
  code: string | null;
  name: string;
  contacts: SupplierDto['contacts'];
  payment_terms: string | null;
  lead_time_days: number | null;
  min_order_minor: bigint | null;
  currency: string | null;
  status: SupplierDto['status'];
  version: number;
  created_at: Date;
  updated_at: Date;
}
export const toSupplierDto = (r: SupplierRow): SupplierDto => ({
  id: r.id,
  tenantId: r.tenant_id,
  code: r.code,
  name: r.name,
  contacts: r.contacts ?? [],
  paymentTerms: r.payment_terms,
  leadTimeDays: r.lead_time_days,
  minOrderMinor: minor(r.min_order_minor),
  currency: r.currency ? r.currency.trim() : null,
  status: r.status,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export interface SupplierItemRow {
  id: string;
  tenant_id: string;
  supplier_id: string;
  variant_id: string;
  supplier_sku: string | null;
  cost_minor: bigint;
  currency: string;
  pack_size: string;
  purchase_unit: string;
  moq: string | null;
  lead_time_days: number | null;
  is_preferred: boolean;
  valid_from: string | Date | null;
  valid_to: string | Date | null;
}
export const toSupplierItemDto = (r: SupplierItemRow): SupplierItemDto => ({
  id: r.id,
  tenantId: r.tenant_id,
  supplierId: r.supplier_id,
  variantId: r.variant_id,
  supplierSku: r.supplier_sku,
  costMinor: minorRequired(r.cost_minor),
  currency: r.currency.trim(),
  packSize: r.pack_size,
  purchaseUnit: r.purchase_unit,
  moq: r.moq,
  leadTimeDays: r.lead_time_days,
  isPreferred: r.is_preferred,
  validFrom: calendarDate(r.valid_from),
  validTo: calendarDate(r.valid_to),
});

export interface ImportJobRow {
  id: string;
  tenant_id: string;
  file_name: string;
  status: CatalogImportDto['status'];
  dry_run: boolean;
  summary: CatalogImportDto['summary'];
  errors: CatalogImportDto['errors'];
  report_csv: string;
  created_by: string | null;
  created_at: Date;
}
export const toImportJobDto = (r: ImportJobRow): CatalogImportDto => ({
  id: r.id,
  tenantId: r.tenant_id,
  fileName: r.file_name,
  status: r.status,
  dryRun: r.dry_run,
  summary: r.summary,
  errors: r.errors ?? [],
  reportUrl: `/v1/catalog/imports/${r.id}/report`,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
});
