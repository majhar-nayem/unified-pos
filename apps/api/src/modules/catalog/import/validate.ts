import {
  BARCODE_KINDS,
  BarcodeCodeSchema,
  CATALOG_IMPORT_COLUMNS,
  type CatalogImportColumn,
  type CatalogImportErrorDto,
  ITEM_KINDS,
  OptionValuesSchema,
  SOLD_BY,
  SkuSchema,
  UnitCodeSchema,
} from '@pos/contracts';
import { defaultCurrencies, fromDecimalString, parseDecimal } from '@pos/domain-core';

import { CsvSyntaxError, type CsvRecord, parseCsv } from './csv.js';

export interface ImportLookups {
  /** category code → id */
  readonly categoryByCode: ReadonlyMap<string, string>;
  /** tax class code → id */
  readonly taxClassByCode: ReadonlyMap<string, string>;
  readonly unitCodes: ReadonlySet<string>;
  /** SKUs and barcodes already in the tenant's catalog (the import is create-only). */
  readonly existingSkus: ReadonlySet<string>;
  readonly existingBarcodes: ReadonlySet<string>;
  /** ISO 4217 code used to read `price` and `cost` (major units). */
  readonly currency: string;
}

export interface PlannedBarcode {
  readonly code: string;
  readonly kind: string;
  readonly packQuantity: string;
  readonly isPrimary: boolean;
}

export interface PlannedVariant {
  readonly sku: string | null;
  readonly name: string | null;
  readonly optionValues: Record<string, string>;
  readonly defaultPriceMinor: string | null;
  readonly costMinor: string | null;
  readonly isDefault: boolean;
  readonly barcodes: PlannedBarcode[];
}

export interface PlannedItem {
  readonly ref: string;
  readonly kind: string;
  readonly name: string;
  readonly categoryId: string | null;
  readonly taxClassId: string | null;
  readonly soldBy: string;
  readonly unitOfMeasure: string;
  readonly trackInventory: boolean;
  readonly variants: PlannedVariant[];
}

export interface ImportPlan {
  readonly items: PlannedItem[];
  readonly errors: CatalogImportErrorDto[];
  /** True count (the list above is capped). */
  readonly errorCount: number;
  readonly rows: number;
  readonly variants: number;
  readonly barcodes: number;
}

export const MAX_REPORTED_ERRORS = 1000;
const COLUMN_SET: ReadonlySet<string> = new Set(CATALOG_IMPORT_COLUMNS);
const BOOLEANS = new Map<string, boolean>([
  ['true', true],
  ['yes', true],
  ['y', true],
  ['1', true],
  ['false', false],
  ['no', false],
  ['n', false],
  ['0', false],
]);

/** Distinct SKUs and barcodes in a file, so the caller can look them up in one query each. */
export function collectKeys(csv: string): { skus: string[]; barcodes: string[] } {
  const skus = new Set<string>();
  const barcodes = new Set<string>();
  try {
    const records = parseCsv(csv);
    const header = headerIndex(records[0]);
    for (const record of records.slice(1)) {
      const sku = cell(record, header, 'sku');
      const barcode = cell(record, header, 'barcode');
      if (sku) skus.add(sku);
      if (barcode) barcodes.add(barcode);
    }
  } catch {
    // syntax errors are reported by validateImport
  }
  return { skus: [...skus], barcodes: [...barcodes] };
}

function headerIndex(record: CsvRecord | undefined): Map<string, number> {
  const index = new Map<string, number>();
  record?.cells.forEach((name, i) => {
    const key = name.trim().toLowerCase();
    if (key && !index.has(key)) index.set(key, i);
  });
  return index;
}

function cell(
  record: CsvRecord,
  header: Map<string, number>,
  column: CatalogImportColumn,
): string | undefined {
  const i = header.get(column);
  if (i === undefined) return undefined;
  const value = record.cells[i]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** Pure: CSV text + lookups → plan and the row-level validation errors. Never touches the database. */
export function validateImport(csv: string, lookups: ImportLookups): ImportPlan {
  const errors: CatalogImportErrorDto[] = [];
  let errorCount = 0;
  const fail = (
    line: number,
    column: string | null,
    code: CatalogImportErrorDto['code'],
    message: string,
  ) => {
    errorCount += 1;
    if (errors.length < MAX_REPORTED_ERRORS) errors.push({ line, column, code, message });
  };

  let records: CsvRecord[];
  try {
    records = parseCsv(csv);
  } catch (error) {
    if (error instanceof CsvSyntaxError) {
      fail(error.line, null, 'EMPTY_FILE', `CSV syntax error: ${error.message}`);
      return { items: [], errors, errorCount, rows: 0, variants: 0, barcodes: 0 };
    }
    throw error;
  }
  if (records.length === 0) {
    fail(1, null, 'EMPTY_FILE', 'The file has no header row');
    return { items: [], errors, errorCount, rows: 0, variants: 0, barcodes: 0 };
  }

  const header = headerIndex(records[0]);
  for (const name of records[0]!.cells.map((c) => c.trim().toLowerCase()).filter(Boolean)) {
    if (!COLUMN_SET.has(name)) fail(1, name, 'UNKNOWN_COLUMN', `Unknown column "${name}"`);
  }
  if (!header.has('item_name'))
    fail(1, 'item_name', 'MISSING_HEADER', 'Required column "item_name" is missing');
  if (records.length === 1) fail(1, null, 'EMPTY_FILE', 'The file has a header but no data rows');
  if (errorCount > 0 && !header.has('item_name')) {
    return { items: [], errors, errorCount, rows: 0, variants: 0, barcodes: 0 };
  }

  const items = new Map<string, PlannedItem & { variants: PlannedVariant[] }>();
  const itemFirstLine = new Map<string, number>();
  const skuInFile = new Map<string, string>(); // sku → item ref
  const variantBySku = new Map<string, PlannedVariant>();
  const barcodeLine = new Map<string, number>();
  let rows = 0;
  let barcodeTotal = 0;
  let variantTotal = 0;
  const exponentCurrency = defaultCurrencies.has(lookups.currency) ? lookups.currency : 'AUD';

  for (const record of records.slice(1)) {
    rows += 1;
    const line = record.line;
    const get = (c: CatalogImportColumn) => cell(record, header, c);

    const itemName = get('item_name');
    const ref = get('item_ref') ?? itemName;
    if (!ref) {
      fail(line, 'item_name', 'MISSING_ITEM_NAME', 'item_name (or item_ref) is required');
      continue;
    }

    // --- item level ---------------------------------------------------------------------
    const kind = get('item_kind');
    if (kind !== undefined && !(ITEM_KINDS as readonly string[]).includes(kind))
      fail(
        line,
        'item_kind',
        'INVALID_ITEM_KIND',
        `"${kind}" is not one of ${ITEM_KINDS.join(', ')}`,
      );
    const soldBy = get('sold_by');
    if (soldBy !== undefined && !(SOLD_BY as readonly string[]).includes(soldBy))
      fail(line, 'sold_by', 'INVALID_SOLD_BY', `"${soldBy}" is not one of ${SOLD_BY.join(', ')}`);
    const categoryCode = get('category_code');
    const categoryId =
      categoryCode === undefined ? null : (lookups.categoryByCode.get(categoryCode) ?? null);
    if (categoryCode !== undefined && categoryId === null)
      fail(line, 'category_code', 'UNKNOWN_CATEGORY', `No category with code "${categoryCode}"`);
    const taxCode = get('tax_class_code');
    const taxClassId = taxCode === undefined ? null : (lookups.taxClassByCode.get(taxCode) ?? null);
    if (taxCode !== undefined && taxClassId === null)
      fail(line, 'tax_class_code', 'UNKNOWN_TAX_CLASS', `No tax class with code "${taxCode}"`);
    const unit = get('unit');
    if (
      unit !== undefined &&
      (!UnitCodeSchema.safeParse(unit).success || !lookups.unitCodes.has(unit))
    )
      fail(line, 'unit', 'UNKNOWN_UNIT', `No unit of measure with code "${unit}"`);
    const trackRaw = get('track_inventory');
    let trackInventory: boolean | undefined;
    if (trackRaw !== undefined) {
      trackInventory = BOOLEANS.get(trackRaw.toLowerCase());
      if (trackInventory === undefined)
        fail(line, 'track_inventory', 'INVALID_TRACK_INVENTORY', `"${trackRaw}" is not true/false`);
    }

    let item = items.get(ref);
    if (!item) {
      if (!itemName)
        fail(
          line,
          'item_name',
          'MISSING_ITEM_NAME',
          `item_ref "${ref}" has no item_name on its first row`,
        );
      item = {
        ref,
        kind: kind ?? 'product',
        name: itemName ?? ref,
        categoryId,
        taxClassId,
        soldBy: soldBy ?? 'unit',
        unitOfMeasure: unit ?? 'each',
        trackInventory: trackInventory ?? true,
        variants: [],
      };
      items.set(ref, item);
      itemFirstLine.set(ref, line);
    } else {
      const first = itemFirstLine.get(ref)!;
      const differs = (column: CatalogImportColumn, shown: string | null) =>
        fail(
          line,
          column,
          'ITEM_CONFLICT',
          `Differs from line ${first} for the same item (${shown ?? 'none'})`,
        );
      if (itemName !== undefined && itemName !== item.name) differs('item_name', item.name);
      if (kind !== undefined && kind !== item.kind) differs('item_kind', item.kind);
      if (categoryCode !== undefined && categoryId !== item.categoryId)
        differs('category_code', null);
      if (taxCode !== undefined && taxClassId !== item.taxClassId) differs('tax_class_code', null);
      if (soldBy !== undefined && soldBy !== item.soldBy) differs('sold_by', item.soldBy);
      if (unit !== undefined && unit !== item.unitOfMeasure) differs('unit', item.unitOfMeasure);
      if (trackInventory !== undefined && trackInventory !== item.trackInventory)
        fail(
          line,
          'track_inventory',
          'ITEM_CONFLICT',
          `Differs from line ${first} for the same item`,
        );
    }

    // --- variant level ------------------------------------------------------------------
    const sku = get('sku');
    let skuOk = true;
    if (sku !== undefined) {
      if (!SkuSchema.safeParse(sku).success) {
        skuOk = false;
        fail(line, 'sku', 'INVALID_SKU', `"${sku}" is not a valid SKU`);
      } else if (lookups.existingSkus.has(sku)) {
        skuOk = false;
        fail(
          line,
          'sku',
          'DUPLICATE_SKU',
          `SKU "${sku}" already exists in the catalog (import is create-only)`,
        );
      } else if (skuInFile.has(sku) && skuInFile.get(sku) !== ref) {
        skuOk = false;
        fail(
          line,
          'sku',
          'DUPLICATE_SKU',
          `SKU "${sku}" is also used by item "${skuInFile.get(sku)}"`,
        );
      }
    }
    const priceRaw = get('price');
    const costRaw = get('cost');
    const price = minorFrom(priceRaw, exponentCurrency, (m) =>
      fail(line, 'price', 'INVALID_PRICE', m),
    );
    const cost = minorFrom(costRaw, exponentCurrency, (m) => fail(line, 'cost', 'INVALID_COST', m));
    const optionRaw = get('option_values');
    let optionValues: Record<string, string> = {};
    if (optionRaw !== undefined) {
      const parsed = parseOptions(optionRaw);
      if (!parsed)
        fail(
          line,
          'option_values',
          'INVALID_OPTION_VALUES',
          'Expected key=value pairs separated by ";" (size=L;colour=red)',
        );
      else optionValues = parsed;
    }

    let variant = sku !== undefined && skuOk ? variantBySku.get(sku) : undefined;
    if (!variant) {
      variant = {
        sku: sku !== undefined && skuOk ? sku : null,
        name: get('variant_name') ?? null,
        optionValues,
        defaultPriceMinor: price,
        costMinor: cost,
        isDefault: item.variants.length === 0,
        barcodes: [],
      };
      item.variants.push(variant);
      variantTotal += 1;
      if (sku !== undefined && skuOk) {
        variantBySku.set(sku, variant);
        skuInFile.set(sku, ref);
      }
    }

    // --- barcode ------------------------------------------------------------------------
    const code = get('barcode');
    const barcodeKind = get('barcode_kind');
    const pack = get('pack_quantity');
    if (code === undefined) {
      if (barcodeKind !== undefined || pack !== undefined)
        fail(
          line,
          barcodeKind !== undefined ? 'barcode_kind' : 'pack_quantity',
          'INVALID_BARCODE',
          'barcode_kind and pack_quantity need a barcode',
        );
      continue;
    }
    let barcodeOk = BarcodeCodeSchema.safeParse(code).success;
    if (!barcodeOk) fail(line, 'barcode', 'INVALID_BARCODE', `"${code}" is not a valid barcode`);
    else if (lookups.existingBarcodes.has(code)) {
      barcodeOk = false;
      fail(
        line,
        'barcode',
        'BARCODE_IN_USE',
        `Barcode "${code}" is already assigned in the catalog`,
      );
    } else if (barcodeLine.has(code)) {
      barcodeOk = false;
      fail(
        line,
        'barcode',
        'DUPLICATE_BARCODE',
        `Barcode "${code}" already appears on line ${barcodeLine.get(code)}`,
      );
    }
    if (barcodeKind !== undefined && !(BARCODE_KINDS as readonly string[]).includes(barcodeKind)) {
      barcodeOk = false;
      fail(
        line,
        'barcode_kind',
        'INVALID_BARCODE_KIND',
        `"${barcodeKind}" is not one of ${BARCODE_KINDS.join(', ')}`,
      );
    }
    if (pack !== undefined && !validPack(pack)) {
      barcodeOk = false;
      fail(
        line,
        'pack_quantity',
        'INVALID_PACK_QUANTITY',
        `"${pack}" must be a positive number with at most 4 decimals`,
      );
    }
    if (barcodeOk) {
      barcodeLine.set(code, line);
      variant.barcodes.push({
        code,
        kind: barcodeKind ?? 'ean13',
        packQuantity: pack ?? '1',
        isPrimary: variant.barcodes.length === 0,
      });
      barcodeTotal += 1;
    }
  }

  return {
    items: [...items.values()],
    errors,
    errorCount,
    rows,
    variants: variantTotal,
    barcodes: barcodeTotal,
  };
}

function minorFrom(
  raw: string | undefined,
  currency: string,
  onError: (message: string) => void,
): string | null {
  if (raw === undefined) return null;
  try {
    if (!/^\d+(\.\d+)?$/.test(raw)) throw new RangeError('not a non-negative decimal');
    return fromDecimalString(raw, currency).amountMinor.toString();
  } catch (error) {
    onError(
      `"${raw}" is not a valid amount in ${currency} major units (${error instanceof Error ? error.message : 'invalid'})`,
    );
    return null;
  }
}

function validPack(value: string): boolean {
  if (!/^\d{1,10}(\.\d{1,4})?$/.test(value)) return false;
  const d = parseDecimal(value);
  return d.unscaled > 0n;
}

function parseOptions(raw: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0 || eq === trimmed.length - 1) return null;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  const result = OptionValuesSchema.safeParse(out);
  return result.success && Object.keys(out).length > 0 ? result.data : null;
}
