import { priceEngine } from '@pos/domain-core';
import { describe, expect, it } from 'vitest';

import {
  OrderDraftSchema,
  PricedOrderSchema,
  PricingPreviewRequestSchema,
  bigintsToStrings,
  toPricedOrderDto,
} from './price-engine.js';

const variant = '0198a000-0000-7000-8000-000000000001';
const location = '0198a000-0000-7000-8000-0000000000aa';
const draft = {
  currency: 'AUD',
  lines: [{ id: 'l1', variantId: variant, quantity: '2', defaultUnitPriceMinor: '1100' }],
};

describe('OrderDraftSchema', () => {
  it('accepts a minimal and a full draft', () => {
    expect(OrderDraftSchema.safeParse(draft).success).toBe(true);
    const full = {
      ...draft,
      manualDiscounts: [
        {
          id: 'd',
          kind: 'percent',
          value: '10',
          authorization: { authorizedBy: 'u', method: 'pin' },
        },
      ],
      charges: [{ id: 'c', kind: 'service_charge', percent: '10' }],
      couponCodes: ['SAVE'],
      customer: { id: variant, groupIds: [variant], taxExempt: false, promotionUses: { p: 1 } },
      tenders: [{ method: 'card', amountMinor: '500' }, { method: 'cash' }],
    };
    expect(OrderDraftSchema.safeParse(full).success).toBe(true);
  });

  it('rejects malformed money, quantities and unknown keys', () => {
    const line = draft.lines[0]!;
    const bad = [
      { ...draft, currency: 'aud' },
      { ...draft, lines: [{ ...line, quantity: '-1' }] },
      { ...draft, lines: [{ ...line, quantity: '1.23456' }] },
      { ...draft, lines: [{ ...line, defaultUnitPriceMinor: '-5' }] },
      { ...draft, lines: [{ ...line, variantId: 'nope' }] },
      { ...draft, lines: [{ ...line, extra: true }] },
      { ...draft, surprise: 1 },
      { ...draft, manualDiscounts: [{ id: 'd', kind: 'percent', value: '101' }] },
      { ...draft, manualDiscounts: [{ id: 'd', kind: 'amount', value: '10.5' }] },
      { ...draft, charges: [{ id: 'c', kind: 'surcharge' }] },
      { ...draft, charges: [{ id: 'c', kind: 'surcharge', amountMinor: '1', percent: '1' }] },
      { ...draft, tenders: [{ method: 'crypto' }] },
    ];
    for (const b of bad)
      expect(OrderDraftSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });

  it('allows a negative modifier ("no cheese") but not a negative line price', () => {
    const line = { ...draft.lines[0]!, modifiers: [{ id: 'm', priceMinor: '-50' }] };
    expect(OrderDraftSchema.safeParse({ ...draft, lines: [line] }).success).toBe(true);
  });

  it('caps the line count', () => {
    const lines = Array.from({ length: 501 }, (_, i) => ({
      id: `l${i}`,
      variantId: variant,
      quantity: '1',
    }));
    expect(OrderDraftSchema.safeParse({ ...draft, lines }).success).toBe(false);
  });
});

describe('PricingPreviewRequestSchema', () => {
  it('needs a location and a draft', () => {
    expect(PricingPreviewRequestSchema.safeParse({ locationId: location, draft }).success).toBe(
      true,
    );
    expect(PricingPreviewRequestSchema.safeParse({ draft }).success).toBe(false);
    expect(PricingPreviewRequestSchema.safeParse({ locationId: location }).success).toBe(false);
  });
  it('accepts the optional context fields', () => {
    const body = {
      locationId: location,
      draft,
      channel: 'pos',
      at: '2026-10-19T02:00:00Z',
      timezone: 'Australia/Sydney',
      jurisdiction: { country: 'AU', region: 'NSW' },
      taxRules: [{ id: 'gst', taxClassId: null, rate: '0.100000', inclusiveDefault: true }],
      stackTaxRules: false,
      cashRounding: { intervalMinor: 5, mode: 'NEAREST_HALF_UP' },
      includeTrace: false,
    };
    expect(PricingPreviewRequestSchema.safeParse(body).success).toBe(true);
    expect(PricingPreviewRequestSchema.safeParse({ ...body, cashRounding: null }).success).toBe(
      true,
    );
    expect(
      PricingPreviewRequestSchema.safeParse({
        ...body,
        cashRounding: { intervalMinor: 0, mode: 'UP' },
      }).success,
    ).toBe(false);
    expect(
      PricingPreviewRequestSchema.safeParse({ ...body, jurisdiction: { country: 'Australia' } })
        .success,
    ).toBe(false);
    expect(PricingPreviewRequestSchema.safeParse({ ...body, at: 'tomorrow' }).success).toBe(false);
  });
});

describe('toPricedOrderDto', () => {
  const priced = priceEngine.priceOrder(
    {
      currency: 'AUD',
      lines: [
        {
          id: 'l1',
          variantId: variant,
          quantity: '2',
          defaultUnitPriceMinor: 1100,
          manualDiscount: {
            id: 'd',
            kind: 'percent',
            value: '10',
            authorization: { authorizedBy: 'mgr', method: 'pin' },
          },
        },
      ],
      charges: [{ id: 'c', kind: 'service_charge', percent: '10' }],
      tenders: [{ method: 'cash' }],
    },
    { at: '2026-10-19T02:00:00Z' },
  );

  it('renders bigints as strings and conforms to the response schema', () => {
    const dto = toPricedOrderDto(priced);
    expect(PricedOrderSchema.parse(dto)).toEqual(dto);
    expect(dto.totalMinor).toBe(priced.totalMinor.toString());
    expect(dto.lines[0]!.taxes[0]!.amountMinor).toBe(
      priced.lines[0]!.taxes[0]!.amountMinor.toString(),
    );
    expect(JSON.stringify(dto)).not.toMatch(/\d+n/);
    expect(dto.trace.length).toBeGreaterThan(5);
  });

  it('can drop the trace', () => {
    expect(toPricedOrderDto(priced, { includeTrace: false }).trace).toEqual([]);
    expect(toPricedOrderDto(priced, { includeTrace: true }).trace.length).toBeGreaterThan(0);
  });

  it('bigintsToStrings recurses and skips undefined', () => {
    expect(
      bigintsToStrings({ a: 1n, b: [2n, { c: 3n }], d: undefined, e: 'x', f: null, g: 4 }),
    ).toEqual({
      a: '1',
      b: ['2', { c: '3' }],
      e: 'x',
      f: null,
      g: 4,
    });
  });
});
