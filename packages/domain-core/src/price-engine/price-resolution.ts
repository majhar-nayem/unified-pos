import type { Decimal } from '../money/decimal.js';
import { toMinor } from '../money/money.js';
import { compareDecimal, nonNegativeMinor, parseQuantity } from './arith.js';
import type {
  DraftLine,
  PriceListAssignment,
  PriceListDefinition,
  PriceListEntry,
  DraftCustomer,
  PriceSource,
  PricingContext,
} from './types.js';

/**
 * Step 1 of docs/01-system-architecture.md §7.2: price override → price lists in scope by
 * priority → variant default.
 *
 * Price lists reach a sale through their assignments. Customer, customer-group and channel
 * assignments form the first tier, location / org-unit / tenant assignments the second; inside a
 * tier the assignment priority, then the list priority (lower first), then specificity (customer
 * before group, nearer org unit before farther) order the candidates, and the first list holding
 * an entry for the variant that is valid at the business time and whose tier quantity is reached
 * wins. Inside one list the highest reached `minQuantity` entry wins, then the latest validFrom.
 */
export interface ResolvedPrice {
  readonly unitPriceMinor: bigint;
  /** Tax mode of the chosen price; undefined when the variant default did not say. */
  readonly taxInclusive: boolean | undefined;
  readonly source: PriceSource;
}

interface Candidate {
  readonly list: PriceListDefinition;
  readonly assignment: PriceListAssignment;
  readonly tier: 0 | 1;
  readonly specificity: number;
}

export function resolveBasePrice(
  line: DraftLine,
  quantity: Decimal,
  draftCurrency: string,
  context: PricingContext,
  customer: DraftCustomer | undefined,
  at: Date,
): ResolvedPrice {
  if (line.priceOverride) {
    const unitPriceMinor = nonNegativeMinor(
      line.priceOverride.unitPriceMinor,
      `Line ${line.id} override`,
    );
    const auth = line.priceOverride.authorization;
    return {
      unitPriceMinor,
      taxInclusive: line.priceOverride.taxInclusive,
      source: {
        kind: 'override',
        ...(auth ? { authorizedBy: auth.authorizedBy } : {}),
        ...(auth?.approvalId ? { approvalId: auth.approvalId } : {}),
      },
    };
  }

  for (const candidate of rankPriceLists(context, draftCurrency, customer)) {
    const entry = pickEntry(candidate.list, line.variantId, quantity, at);
    if (!entry) continue;
    return {
      unitPriceMinor: nonNegativeMinor(entry.priceMinor, `Price list entry ${entry.id}`),
      taxInclusive: candidate.list.taxInclusive,
      source: { kind: 'price_list', priceListId: candidate.list.id, entryId: entry.id },
    };
  }

  if (line.defaultUnitPriceMinor === undefined || line.defaultUnitPriceMinor === null) {
    throw new RangeError(
      `Line ${line.id}: no price list prices variant ${line.variantId} and it has no default price`,
    );
  }
  const unitPriceMinor = toMinor(line.defaultUnitPriceMinor);
  if (unitPriceMinor < 0n)
    throw new RangeError(`Line ${line.id}: default price must not be negative`);
  return {
    unitPriceMinor,
    taxInclusive: line.defaultTaxInclusive,
    source: { kind: 'variant_default' },
  };
}

/** Every (list, assignment) pair that reaches the sale, best first. */
export function rankPriceLists(
  context: PricingContext,
  currency: string,
  customer: DraftCustomer | undefined,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const list of context.priceLists ?? []) {
    if ((list.status ?? 'active') !== 'active') continue;
    if (list.currency.toUpperCase() !== currency) continue;
    for (const assignment of list.assignments) {
      const match = matchAssignment(assignment, context, customer);
      if (match) candidates.push({ list, assignment, ...match });
    }
  }
  return candidates.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const pa = a.assignment.priority ?? 100;
    const pb = b.assignment.priority ?? 100;
    if (pa !== pb) return pa - pb;
    const la = a.list.priority ?? 100;
    const lb = b.list.priority ?? 100;
    if (la !== lb) return la - lb;
    if (a.specificity !== b.specificity) return b.specificity - a.specificity;
    if (a.list.id !== b.list.id) return a.list.id < b.list.id ? -1 : 1;
    const ia = a.assignment.id ?? '';
    const ib = b.assignment.id ?? '';
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

function matchAssignment(
  assignment: PriceListAssignment,
  context: PricingContext,
  customer: DraftCustomer | undefined,
): { tier: 0 | 1; specificity: number } | null {
  switch (assignment.scopeKind) {
    case 'customer':
      return customer?.id && assignment.scopeId === customer.id
        ? { tier: 0, specificity: 30 }
        : null;
    case 'customer_group':
      return assignment.scopeId && customer?.groupIds?.includes(assignment.scopeId)
        ? { tier: 0, specificity: 20 }
        : null;
    case 'channel':
      return context.channel && assignment.scopeValue === context.channel
        ? { tier: 0, specificity: 10 }
        : null;
    case 'location':
      return context.locationId && assignment.scopeId === context.locationId
        ? { tier: 1, specificity: 1000 }
        : null;
    case 'org_unit': {
      const path = context.orgUnitPath ?? [];
      const index = assignment.scopeId ? path.indexOf(assignment.scopeId) : -1;
      return index >= 0 ? { tier: 1, specificity: 900 - index } : null;
    }
    case 'tenant':
      return { tier: 1, specificity: 0 };
    default:
      return null;
  }
}

export function pickEntry(
  list: PriceListDefinition,
  variantId: string,
  quantity: Decimal,
  at: Date,
): PriceListEntry | null {
  let best: PriceListEntry | null = null;
  let bestMin: Decimal | null = null;
  for (const entry of list.entries) {
    if (entry.variantId !== variantId) continue;
    if (!entryValidAt(entry, at)) continue;
    const min = parseQuantity(entry.minQuantity ?? '1', `Price list entry ${entry.id}`);
    if (compareDecimal(min, quantity) > 0) continue;
    if (best === null || bestMin === null) {
      best = entry;
      bestMin = min;
      continue;
    }
    const byMin = compareDecimal(min, bestMin);
    if (byMin > 0 || (byMin === 0 && laterValidFrom(entry, best))) {
      best = entry;
      bestMin = min;
    }
  }
  return best;
}

function entryValidAt(entry: PriceListEntry, at: Date): boolean {
  const t = at.getTime();
  if (entry.validFrom && new Date(entry.validFrom).getTime() > t) return false;
  if (entry.validTo && new Date(entry.validTo).getTime() <= t) return false;
  return true;
}

function laterValidFrom(a: PriceListEntry, b: PriceListEntry): boolean {
  const ta = a.validFrom ? new Date(a.validFrom).getTime() : Number.NEGATIVE_INFINITY;
  const tb = b.validFrom ? new Date(b.validFrom).getTime() : Number.NEGATIVE_INFINITY;
  if (ta !== tb) return ta > tb;
  return a.id < b.id;
}
