/**
 * PLACEHOLDER catalog types for the POS shell.
 *
 * TODO(integration): replace with `CatalogPort` / `VariantLookupDto` from @pos/contracts (stream
 * S-F2) once the catalog replica feed exists. Until then the shell reads whatever the replica holds
 * and maps it defensively; the checkout slice (F6b) owns real line pricing through `PricingPort`.
 */
import type { ChangeRecord } from '@pos/sync-protocol';

import type { ReplicaRecord } from '../store/stores.js';

export interface PosProduct {
  readonly variantId: string;
  readonly name: string;
  /** Minor units. Placeholder price: variant default price, not a priced result. */
  readonly priceMinor: bigint;
  readonly categoryId: string | null;
  readonly soldBy: 'each' | 'weight';
  readonly barcodes: readonly string[];
}

export interface PosCategory {
  readonly id: string;
  readonly name: string;
}

export function toProduct(record: ReplicaRecord): PosProduct | null {
  const p = record.payload;
  const name =
    typeof p.name === 'string' ? p.name : typeof p.itemName === 'string' ? p.itemName : null;
  const price = p.defaultPriceMinor ?? p.priceMinor;
  if (!name || typeof price !== 'string' || !/^-?\d+$/.test(price)) return null;
  return {
    variantId: record.entityId,
    name,
    priceMinor: BigInt(price),
    categoryId: typeof p.categoryId === 'string' ? p.categoryId : null,
    soldBy: p.soldBy === 'weight' ? 'weight' : 'each',
    barcodes: Array.isArray(p.barcodes)
      ? p.barcodes
          .map((b) => (typeof b === 'string' ? b : ((b as { code?: string }).code ?? '')))
          .filter(Boolean)
      : [],
  };
}

export function toCategory(record: ReplicaRecord): PosCategory | null {
  return typeof record.payload.name === 'string'
    ? { id: record.entityId, name: record.payload.name }
    : null;
}

/**
 * STUB DATA: demo catalogue loaded when the API has no change-feed yet. Mirrors the wireframe in
 * docs/04-design-plan.md §4.1. Versions are 1 so a real feed record (any version ≥ 2, or the same
 * version once the stub is replaced by the integration slice) supersedes it.
 */
export const STUB_CATALOG_RECORDS: readonly ChangeRecord[] = (() => {
  const categories = [
    ['cat-dairy', 'Dairy'],
    ['cat-bakery', 'Bakery'],
    ['cat-produce', 'Produce'],
    ['cat-drinks', 'Drinks'],
  ] as const;
  const products: Array<[string, string, string, string, string, 'each' | 'weight']> = [
    // id, name, price (minor), category, barcode, soldBy
    ['var-oat-milk', 'Oat Milk 1L', '450', 'cat-dairy', '9300675024235', 'each'],
    ['var-butter', 'Butter 250g', '620', 'cat-dairy', '9300675024242', 'each'],
    ['var-sourdough', 'Sourdough Loaf', '800', 'cat-bakery', '9300675024259', 'each'],
    ['var-bagels', 'Bagels 4pk', '650', 'cat-bakery', '9300675024266', 'each'],
    ['var-croissant', 'Croissant', '480', 'cat-bakery', '9300675024273', 'each'],
    ['var-bananas', 'Bananas (per kg)', '399', 'cat-produce', '9300675024280', 'weight'],
    ['var-apples', 'Apples (per kg)', '549', 'cat-produce', '9300675024297', 'weight'],
    ['var-coffee-beans', 'Coffee Beans 250g', '1400', 'cat-drinks', '9300675024303', 'each'],
    ['var-coffee', 'Coffee', '450', 'cat-drinks', '9300675024310', 'each'],
    ['var-juice', 'Orange Juice 1L', '520', 'cat-drinks', '9300675024327', 'each'],
  ];
  let seq = 0;
  const records: ChangeRecord[] = [];
  for (const [id, name] of categories)
    records.push({
      seq: ++seq,
      stream: 'catalog',
      entity: 'category',
      entityId: id,
      op: 'upsert',
      version: 1,
      payload: { name },
    });
  for (const [id, name, price, categoryId, code, soldBy] of products)
    records.push({
      seq: ++seq,
      stream: 'catalog',
      entity: 'variant',
      entityId: id,
      op: 'upsert',
      version: 1,
      payload: {
        name,
        defaultPriceMinor: price,
        categoryId,
        soldBy,
        barcodes: [{ code }],
        stub: true,
      },
    });
  return records;
})();
