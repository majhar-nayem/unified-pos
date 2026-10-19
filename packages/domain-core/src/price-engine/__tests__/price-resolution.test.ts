import { parseDecimal } from '../../money/decimal.js';
import { describe, expect, it } from 'vitest';

import { pickEntry, rankPriceLists, resolveBasePrice } from '../price-resolution.js';
import type { DraftLine, PriceListDefinition } from '../types.js';
import { ctx, line } from './helpers.js';

const at = new Date('2026-10-19T02:00:00Z');
const list = (id: string, extra: Partial<PriceListDefinition> = {}): PriceListDefinition => ({
  id,
  currency: 'AUD',
  taxInclusive: true,
  entries: [{ id: `${id}-e`, variantId: 'v-a', priceMinor: 500 }],
  assignments: [{ scopeKind: 'tenant' }],
  ...extra,
});
const resolve = (l: DraftLine, c = ctx(), customer?: Parameters<typeof resolveBasePrice>[4]) =>
  resolveBasePrice(l, parseDecimal(l.quantity), 'AUD', c, customer, at);

describe('resolveBasePrice', () => {
  it('override beats everything and records the authoriser', () => {
    const r = resolve(
      line('a', 1, 1000, {
        priceOverride: {
          unitPriceMinor: 700,
          taxInclusive: false,
          authorization: { authorizedBy: 'm', approvalId: 'ap' },
        },
      }),
      ctx({ priceLists: [list('pl')] }),
    );
    expect(r).toEqual({
      unitPriceMinor: 700n,
      taxInclusive: false,
      source: { kind: 'override', authorizedBy: 'm', approvalId: 'ap' },
    });
    expect(resolve(line('a', 1, 1000, { priceOverride: { unitPriceMinor: 5 } })).source).toEqual({
      kind: 'override',
    });
    expect(() => resolve(line('a', 1, 1000, { priceOverride: { unitPriceMinor: -1 } }))).toThrow(
      RangeError,
    );
  });

  it('falls back to the variant default and carries its tax mode', () => {
    expect(resolve(line('a', 1, 1000, { defaultTaxInclusive: false }))).toEqual({
      unitPriceMinor: 1000n,
      taxInclusive: false,
      source: { kind: 'variant_default' },
    });
    expect(() => resolve({ id: 'x', variantId: 'v', quantity: '1' })).toThrow(
      /no price list prices variant/,
    );
    expect(() =>
      resolve({ id: 'x', variantId: 'v', quantity: '1', defaultUnitPriceMinor: null }),
    ).toThrow(/no price list/);
    expect(() => resolve(line('a', 1, -5))).toThrow(/must not be negative/);
    expect(resolve(line('a', 1, 0)).unitPriceMinor).toBe(0n);
  });

  it('uses the best list and reports its tax mode', () => {
    const r = resolve(
      line('a', 1, 1000),
      ctx({ priceLists: [list('pl', { taxInclusive: false })] }),
    );
    expect(r.unitPriceMinor).toBe(500n);
    expect(r.taxInclusive).toBe(false);
    expect(r.source).toEqual({ kind: 'price_list', priceListId: 'pl', entryId: 'pl-e' });
  });
});

describe('rankPriceLists', () => {
  const ids = (c: ReturnType<typeof ctx>, customer?: Parameters<typeof rankPriceLists>[2]) =>
    rankPriceLists(c, 'AUD', customer).map((x) => x.list.id);

  it('orders customer tiers before location tiers regardless of priority', () => {
    const c = ctx({
      priceLists: [
        list('loc', { assignments: [{ scopeKind: 'location', scopeId: 'loc-syd', priority: 1 }] }),
        list('grp', { assignments: [{ scopeKind: 'customer_group', scopeId: 'g' }] }),
        list('cust', { assignments: [{ scopeKind: 'customer', scopeId: 'c' }] }),
        list('chan', { assignments: [{ scopeKind: 'channel', scopeValue: 'pos' }] }),
      ],
    });
    expect(ids(c, { id: 'c', groupIds: ['g'] })).toEqual(['cust', 'grp', 'chan', 'loc']);
  });

  it('skips lists that do not reach the sale', () => {
    const c = ctx({
      priceLists: [
        list('other-loc', { assignments: [{ scopeKind: 'location', scopeId: 'loc-mel' }] }),
        list('other-ou', { assignments: [{ scopeKind: 'org_unit', scopeId: 'ou-vic' }] }),
        list('other-chan', { assignments: [{ scopeKind: 'channel', scopeValue: 'online' }] }),
        list('cust', { assignments: [{ scopeKind: 'customer', scopeId: 'c' }] }),
        list('grp', { assignments: [{ scopeKind: 'customer_group', scopeId: 'g' }] }),
        list('draft', { status: 'draft' }),
        list('usd', { currency: 'usd' }),
        list('ok'),
      ],
    });
    expect(ids(c)).toEqual(['ok']);
    expect(ids(c, { id: 'someone-else', groupIds: ['x'] })).toEqual(['ok']);
    expect(ids({ ...c, locationId: null, channel: null })).toEqual(['ok']);
    expect(ids({ ...c, orgUnitPath: undefined })).toEqual(['ok']);
    expect(
      rankPriceLists(ctx({ priceLists: [list('usd', { currency: 'usd' })] }), 'USD', undefined),
    ).toHaveLength(1);
  });

  it('orders by assignment priority, list priority, specificity, then id', () => {
    const c = ctx({
      priceLists: [
        list('z-same', { assignments: [{ scopeKind: 'tenant' }] }),
        list('a-same', { assignments: [{ scopeKind: 'tenant' }] }),
        list('lp', { priority: 10, assignments: [{ scopeKind: 'tenant' }] }),
        list('ap', { assignments: [{ scopeKind: 'tenant', priority: 5 }] }),
        list('loc', { assignments: [{ scopeKind: 'location', scopeId: 'loc-syd' }] }),
        list('ou-near', { assignments: [{ scopeKind: 'org_unit', scopeId: 'ou-nsw' }] }),
        list('ou-far', { assignments: [{ scopeKind: 'org_unit', scopeId: 'ou-root' }] }),
      ],
    });
    expect(ids(c)).toEqual(['ap', 'lp', 'loc', 'ou-near', 'ou-far', 'a-same', 'z-same']);
  });

  it('breaks the last tie on assignment id', () => {
    const c = ctx({
      priceLists: [
        list('same', {
          assignments: [
            { id: 'b', scopeKind: 'tenant' },
            { id: 'a', scopeKind: 'tenant' },
          ],
        }),
      ],
    });
    expect(rankPriceLists(c, 'AUD', undefined).map((x) => x.assignment.id)).toEqual(['a', 'b']);
  });
});

describe('pickEntry', () => {
  const entries = (...e: PriceListDefinition['entries'][number][]) => list('l', { entries: e });
  const q = (v: string) => parseDecimal(v);

  it('picks the highest reached minimum quantity', () => {
    const l = entries(
      { id: 'one', variantId: 'v-a', priceMinor: 100 },
      { id: 'six', variantId: 'v-a', priceMinor: 90, minQuantity: '6' },
      { id: 'twelve', variantId: 'v-a', priceMinor: 80, minQuantity: '12' },
    );
    expect(pickEntry(l, 'v-a', q('1'), at)!.id).toBe('one');
    expect(pickEntry(l, 'v-a', q('5.9999'), at)!.id).toBe('one');
    expect(pickEntry(l, 'v-a', q('6'), at)!.id).toBe('six');
    expect(pickEntry(l, 'v-a', q('11'), at)!.id).toBe('six');
    expect(pickEntry(l, 'v-a', q('12'), at)!.id).toBe('twelve');
    expect(pickEntry(l, 'v-other', q('12'), at)).toBeNull();
    expect(
      pickEntry(
        entries({ id: 'x', variantId: 'v-a', priceMinor: 1, minQuantity: '2' }),
        'v-a',
        q('1'),
        at,
      ),
    ).toBeNull();
  });

  it('respects validity windows (validTo exclusive) and prefers the latest validFrom', () => {
    const l = entries(
      { id: 'old', variantId: 'v-a', priceMinor: 100, validFrom: '2026-01-01T00:00:00Z' },
      { id: 'new', variantId: 'v-a', priceMinor: 90, validFrom: '2026-10-01T00:00:00Z' },
      { id: 'undated', variantId: 'v-a', priceMinor: 95 },
      { id: 'future', variantId: 'v-a', priceMinor: 1, validFrom: '2026-10-19T02:00:01Z' },
      { id: 'ended', variantId: 'v-a', priceMinor: 2, validTo: '2026-10-19T02:00:00Z' },
    );
    expect(pickEntry(l, 'v-a', q('1'), at)!.id).toBe('new');
    const starting = entries({
      id: 's',
      variantId: 'v-a',
      priceMinor: 1,
      validFrom: '2026-10-19T02:00:00Z',
    });
    expect(pickEntry(starting, 'v-a', q('1'), at)!.id).toBe('s');
    const ending = entries({
      id: 'e',
      variantId: 'v-a',
      priceMinor: 1,
      validTo: '2026-10-19T02:00:01Z',
    });
    expect(pickEntry(ending, 'v-a', q('1'), at)!.id).toBe('e');
  });

  it('breaks exact ties on id, and prefers dated over undated', () => {
    const tie = entries(
      { id: 'b', variantId: 'v-a', priceMinor: 1 },
      { id: 'a', variantId: 'v-a', priceMinor: 2 },
    );
    expect(pickEntry(tie, 'v-a', q('1'), at)!.id).toBe('a');
    const dated = entries(
      { id: 'undated', variantId: 'v-a', priceMinor: 1 },
      { id: 'dated', variantId: 'v-a', priceMinor: 2, validFrom: '2026-01-01T00:00:00Z' },
    );
    expect(pickEntry(dated, 'v-a', q('1'), at)!.id).toBe('dated');
  });
});
