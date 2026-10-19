/**
 * Catalog port (docs/03 §15.1): what the order engine (S-F4) and price engine (S-F3) need from
 * the catalog without touching its tables. The API binds it to catalog.* per tenant; the POS app
 * to its local replica.
 */
export interface CatalogVariantSnapshot {
  readonly variantId: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly variantName: string | null;
  readonly sku: string | null;
  readonly kind: string;
  readonly soldBy: string;
  readonly unitOfMeasure: string;
  readonly taxClassId: string | null;
  readonly taxClassCode: string | null;
  /** List price fallback (minor units) when no price list applies; null when the variant has none. */
  readonly defaultPriceMinor: bigint | null;
  readonly trackInventory: boolean;
  readonly isAgeRestricted: boolean;
  readonly minAge: number | null;
  readonly itemStatus: string;
  readonly variantStatus: string;
  readonly itemVersion: number;
  readonly variantVersion: number;
}

export interface BarcodeHit {
  readonly snapshot: CatalogVariantSnapshot;
  /** Units one scan represents (case barcodes). Decimal string. */
  readonly packQuantity: string;
  readonly barcodeKind: string;
}

export interface CatalogPort {
  variantSnapshot(variantId: string): Promise<CatalogVariantSnapshot | null>;
  variantSnapshots(
    variantIds: readonly string[],
  ): Promise<ReadonlyMap<string, CatalogVariantSnapshot>>;
  lookupBySku(sku: string): Promise<CatalogVariantSnapshot | null>;
  lookupByBarcode(code: string): Promise<BarcodeHit | null>;
}
