import { describe, expect, it } from 'vitest';

import {
  BarcodeCodeSchema,
  CATALOG_IMPORT_COLUMNS,
  CreateItemSchema,
  CreateModifierGroupSchema,
  CreateTaxRuleSchema,
  CursorQuerySchema,
  ItemAttributesSchema,
  MenuResolveQuerySchema,
  MenuScheduleSchema,
  ModifierGroupOverridesSchema,
  OptionValuesSchema,
  PutItemAvailabilitySchema,
  SkuSchema,
  TaxRateSchema,
  decimalString,
} from './index.js';

const id = '0190f8a0-0000-7000-8000-000000000001';

describe('catalog contracts', () => {
  it('jsonb column schemas accept their documented shapes and reject others', () => {
    expect(OptionValuesSchema.safeParse({ size: 'L', colour: 'red' }).success).toBe(true);
    expect(OptionValuesSchema.safeParse({ size: 3 }).success).toBe(false);
    expect(
      ItemAttributesSchema.safeParse({ size: ['S', 'M'], organic: true, grams: 250 }).success,
    ).toBe(true);
    expect(ItemAttributesSchema.safeParse({ nested: { a: 1 } }).success).toBe(false);
    expect(
      ModifierGroupOverridesSchema.safeParse({
        selectionMin: 0,
        selectionMax: null,
        allowRepeat: true,
        modifierPrices: { [id]: '-50' },
      }).success,
    ).toBe(true);
    expect(
      ModifierGroupOverridesSchema.safeParse({ modifierPrices: { notAnId: '1' } }).success,
    ).toBe(false);
    expect(
      ModifierGroupOverridesSchema.safeParse({ modifierPrices: { [id]: '1.5' } }).success,
    ).toBe(false);
  });

  it('menu schedules: ISO weekdays and HH:MM windows (a window may span midnight)', () => {
    expect(
      MenuScheduleSchema.safeParse({
        days: [1, 2, 3],
        windows: [
          { from: '06:00', to: '11:00' },
          { from: '22:00', to: '02:00' },
        ],
      }).success,
    ).toBe(true);
    expect(MenuScheduleSchema.safeParse({}).success).toBe(true);
    expect(MenuScheduleSchema.safeParse({ days: [0] }).success).toBe(false);
    expect(MenuScheduleSchema.safeParse({ days: [8] }).success).toBe(false);
    expect(MenuScheduleSchema.safeParse({ windows: [{ from: '6:00', to: '11:00' }] }).success).toBe(
      false,
    );
    expect(
      MenuScheduleSchema.safeParse({ windows: [{ from: '24:00', to: '25:00' }] }).success,
    ).toBe(false);
  });

  it('money and quantities are integer / decimal strings, never numbers', () => {
    expect(
      CreateItemSchema.safeParse({
        kind: 'product',
        name: 'x',
        variants: [{ defaultPriceMinor: '450' }],
      }).success,
    ).toBe(true);
    expect(
      CreateItemSchema.safeParse({
        kind: 'product',
        name: 'x',
        variants: [{ defaultPriceMinor: 450 }],
      }).success,
    ).toBe(false);
    expect(
      CreateItemSchema.safeParse({
        kind: 'product',
        name: 'x',
        variants: [{ defaultPriceMinor: '4.50' }],
      }).success,
    ).toBe(false);
    expect(decimalString(4).safeParse('12.5').success).toBe(true);
    expect(decimalString(4).safeParse('12.12345').success).toBe(false);
    expect(TaxRateSchema.safeParse('0.100000').success).toBe(true);
    expect(TaxRateSchema.safeParse('0.1000001').success).toBe(false);
    expect(TaxRateSchema.safeParse('-0.1').success).toBe(false);
  });

  it('identifier shapes: SKU, barcode, modifier group bounds, availability target, tax rule', () => {
    expect(SkuSchema.safeParse('TEE-S/1').success).toBe(true);
    expect(SkuSchema.safeParse('has space').success).toBe(false);
    expect(BarcodeCodeSchema.safeParse('9300000000017').success).toBe(true);
    expect(BarcodeCodeSchema.safeParse('93 000').success).toBe(false);
    expect(
      CreateModifierGroupSchema.safeParse({ name: 'g', selectionMin: 2, selectionMax: 1 }).success,
    ).toBe(false);
    expect(
      CreateModifierGroupSchema.safeParse({ name: 'g', selectionMin: 1, selectionMax: null })
        .success,
    ).toBe(true);
    expect(PutItemAvailabilitySchema.safeParse({ itemId: id, isAvailable: false }).success).toBe(
      true,
    );
    expect(
      PutItemAvailabilitySchema.safeParse({ itemId: id, variantId: id, isAvailable: false })
        .success,
    ).toBe(false);
    expect(PutItemAvailabilitySchema.safeParse({ isAvailable: false }).success).toBe(false);
    expect(
      CreateTaxRuleSchema.safeParse({
        name: 'GST',
        jurisdictionCountry: 'AU',
        kind: 'vat_gst',
        rate: '0.100000',
        validFrom: '2000-07-01',
      }).success,
    ).toBe(true);
    expect(
      CreateTaxRuleSchema.safeParse({
        name: 'GST',
        jurisdictionCountry: 'Australia',
        kind: 'vat_gst',
        rate: '0.1',
        validFrom: '2000-07-01',
      }).success,
    ).toBe(false);
  });

  it('pagination and resolution queries coerce strings from the query string', () => {
    expect(CursorQuerySchema.parse({}).limit).toBe(50);
    expect(CursorQuerySchema.parse({ limit: '25' }).limit).toBe(25);
    expect(CursorQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
    expect(CursorQuerySchema.safeParse({ cursor: 'nope' }).success).toBe(false);
    expect(
      MenuResolveQuerySchema.safeParse({
        locationId: id,
        channel: 'dine_in',
        at: '2026-10-20T08:00:00+11:00',
      }).success,
    ).toBe(true);
    expect(MenuResolveQuerySchema.safeParse({ locationId: id, channel: 'all' }).success).toBe(
      false,
    );
  });

  it('the import column list is the documented, stable header', () => {
    expect(CATALOG_IMPORT_COLUMNS).toContain('item_name');
    expect(new Set(CATALOG_IMPORT_COLUMNS).size).toBe(CATALOG_IMPORT_COLUMNS.length);
  });
});
