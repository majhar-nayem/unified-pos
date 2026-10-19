import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildReport } from './import.service.js';
import { parseCsv, toCsv } from './csv.js';
import { type ImportLookups, validateImport } from './validate.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'golden');
const read = (name: string) => readFileSync(join(dir, name), 'utf8');

/** What the tenant already has when the golden files are imported. */
const LOOKUPS: ImportLookups = {
  categoryByCode: new Map([
    ['apparel', 'cat-apparel'],
    ['produce', 'cat-produce'],
  ]),
  taxClassByCode: new Map([
    ['standard', 'tc-standard'],
    ['gst_free', 'tc-gst-free'],
    ['input_taxed', 'tc-input-taxed'],
  ]),
  unitCodes: new Set(['each', 'kg', 'g', 'l', 'ml']),
  existingSkus: new Set(['EXISTING-1']),
  existingBarcodes: new Set(['9300000000999']),
  currency: 'AUD',
};

const GOLDEN = ['valid', 'duplicate-barcode', 'bad-tax-class', 'bad-unit'] as const;

describe('catalog import golden files', () => {
  it.each(GOLDEN)('%s.csv produces exactly the expected summary and errors', (name) => {
    const expected = JSON.parse(read(`${name}.expected.json`)) as {
      summary: { rows: number; items: number; variants: number; barcodes: number; errors: number };
      errors: Array<{ line: number; column: string; code: string }>;
    };
    const plan = validateImport(read(`${name}.csv`), LOOKUPS);
    expect({
      rows: plan.rows,
      items: plan.items.length,
      variants: plan.variants,
      barcodes: plan.barcodes,
      errors: plan.errorCount,
    }).toEqual(expected.summary);
    expect(plan.errors.map(({ line, column, code }) => ({ line, column, code }))).toEqual(
      expected.errors,
    );
  });

  it('the valid file plans the expected items, variants, prices in minor units and barcodes', () => {
    const plan = validateImport(read('valid.csv'), LOOKUPS);
    expect(
      plan.items.map((i) => [
        i.name,
        i.kind,
        i.categoryId,
        i.taxClassId,
        i.soldBy,
        i.unitOfMeasure,
        i.trackInventory,
      ]),
    ).toEqual([
      ['Logo T-shirt', 'product', 'cat-apparel', 'tc-standard', 'unit', 'each', true],
      ['Bananas, loose', 'product', 'cat-produce', 'tc-gst-free', 'weight', 'kg', true],
      ['Espresso', 'menu_item', null, 'tc-standard', 'unit', 'each', false],
    ]);
    const tee = plan.items[0]!;
    expect(
      tee.variants.map((v) => [
        v.sku,
        v.name,
        v.optionValues,
        v.defaultPriceMinor,
        v.costMinor,
        v.isDefault,
      ]),
    ).toEqual([
      ['TEE-S', 'Small', { size: 'S' }, '2995', '1200', true],
      ['TEE-M', 'Medium', { size: 'M' }, '2995', '1200', false],
    ]);
    // the third row repeats TEE-M and only adds a case barcode
    expect(tee.variants[1]!.barcodes).toEqual([
      { code: '9300000000024', kind: 'ean13', packQuantity: '1', isPrimary: true },
      { code: '9300000000048', kind: 'code128', packQuantity: '12', isPrimary: false },
    ]);
    expect(plan.items[1]!.variants[0]).toMatchObject({
      defaultPriceMinor: '499',
      costMinor: '250',
    });
    expect(plan.items[1]!.variants[0]!.barcodes[0]).toMatchObject({ kind: 'plu' });
  });

  it('reports structural problems with line numbers', () => {
    const codes = (csv: string) =>
      validateImport(csv, LOOKUPS).errors.map((e) => `${e.line}:${e.code}`);
    expect(codes('')).toEqual(['1:EMPTY_FILE']);
    expect(codes('item_name\n')).toEqual(['1:EMPTY_FILE']);
    expect(codes('sku,price\nA,1.00\n')).toEqual(['1:MISSING_HEADER']);
    expect(codes('item_name,colour\nA,red\n')).toEqual(['1:UNKNOWN_COLUMN']);
    expect(codes('item_name,price\nA,1.005\nB,-1\nC,abc\n')).toEqual([
      '2:INVALID_PRICE',
      '3:INVALID_PRICE',
      '4:INVALID_PRICE',
    ]);
    expect(codes('item_name,sku\nA,EXISTING-1\nB,B 1\n')).toEqual([
      '2:DUPLICATE_SKU',
      '3:INVALID_SKU',
    ]);
    expect(codes('item_name,sku\nA,S1\nB,S1\n')).toEqual(['3:DUPLICATE_SKU']);
    expect(codes('item_name,item_kind,sold_by,category_code\nA,gadget,bulk,nope\n')).toEqual([
      '2:INVALID_ITEM_KIND',
      '2:INVALID_SOLD_BY',
      '2:UNKNOWN_CATEGORY',
    ]);
    expect(codes('item_name,barcode,barcode_kind,pack_quantity\nA,123,laser,0\n')).toEqual([
      '2:INVALID_BARCODE_KIND',
      '2:INVALID_PACK_QUANTITY',
    ]);
    expect(codes('item_name,option_values\nA,size\n')).toEqual(['2:INVALID_OPTION_VALUES']);
    expect(codes('item_name,track_inventory\nA,maybe\n')).toEqual(['2:INVALID_TRACK_INVENTORY']);
    expect(codes('item_ref,item_name,category_code\nx,A,apparel\nx,B,produce\n')).toEqual([
      '3:ITEM_CONFLICT',
      '3:ITEM_CONFLICT',
    ]);
    expect(codes('item_name\n"unterminated\n')).toEqual(['2:EMPTY_FILE']);
    expect(codes('item_name,price\n,5.00\n')).toEqual(['2:MISSING_ITEM_NAME']);
  });

  it('reads prices with the tenant currency exponent (JPY has no minor unit)', () => {
    const plan = validateImport('item_name,price\nRamen,1200\nBad,12.5\n', {
      ...LOOKUPS,
      currency: 'JPY',
    });
    expect(plan.items[0]!.variants[0]!.defaultPriceMinor).toBe('1200');
    expect(plan.errors.map((e) => `${e.line}:${e.code}`)).toEqual(['3:INVALID_PRICE']);
  });

  it('the validation report is a CSV a spreadsheet cannot execute', () => {
    const plan = validateImport(read('bad-unit.csv'), LOOKUPS);
    const report = buildReport(plan.errors);
    expect(report.split('\r\n')[0]).toBe('line,column,code,message');
    expect(parseCsv(report)[1]!.cells.slice(0, 3)).toEqual(['2', 'unit', 'UNKNOWN_UNIT']);
    expect(toCsv([['=HYPERLINK("http://x")', 'a,b', 'q"uote']])).toBe(
      '"\'=HYPERLINK(""http://x"")","a,b","q""uote"\r\n',
    );
  });

  it('parses RFC 4180 edge cases: BOM, CRLF, quoted newlines and doubled quotes', () => {
    const records = parseCsv('﻿a,b\r\n"x\ny","he said ""hi"""\r\n\r\nlast,row');
    expect(records.map((r) => [r.line, ...r.cells])).toEqual([
      [1, 'a', 'b'],
      [2, 'x\ny', 'he said "hi"'],
      [5, 'last', 'row'],
    ]);
  });
});
