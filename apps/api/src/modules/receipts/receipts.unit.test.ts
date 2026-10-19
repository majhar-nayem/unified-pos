import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { orders } from '@pos/domain-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OrderState } from '../orders/public/index.js';
import { LocalDiskObjectStore } from './local-disk-object-store.js';
import { parseModel, serializeModel } from './model-json.js';
import { assertSafeKey } from './object-store.js';
import { renderReceiptHtml } from './receipt.html.js';
import { renderReceiptPdf } from './receipt.pdf.js';
import { ReceiptNotAvailable, decideReceipt, naturalKind } from './receipt-policy.js';

// ---- fixtures: real aggregates built with the domain reducers --------------------------------

let counter = 0;
const ctx = (): orders.CommandContext => ({
  now: '2026-10-18T03:00:00.000Z',
  actorId: 'u',
  newId: () => `id-${++counter}`,
  pricing: new orders.StubPricingPort(),
});
const snap = (name: string, price: bigint) => ({
  variantId: null,
  itemSnapshot: { name },
  unitOfMeasure: 'each',
  listPriceMinor: price,
});

function completedSale(name = 'Latte', price = 1100n): OrderState {
  const c = ctx();
  let o = orders.createOrder(
    {
      tenantId: 't',
      locationId: 'l',
      businessDate: '2026-10-18',
      kind: 'retail_sale',
      currency: 'AUD',
    },
    c,
  ).state;
  o = orders.addLine(o, { snapshot: snap(name, price), quantity: '1' }, c).state;
  o = orders.place(o, { orderNumber: 42 }, c).state;
  o = orders.applyPayment(o, { amountMinor: o.totalMinor, paymentRef: 'p' }, c).state;
  return orders.markPaid(o, c).state;
}

const model = (
  o: OrderState,
  kind: orders.ReceiptKind = 'sale',
  extra: Partial<orders.ReceiptBuildContext> = {},
) =>
  orders.buildReceiptModel(o, {
    kind,
    number: '20261018-0042',
    businessName: 'Acme (Pty) Ltd',
    locationName: 'Acme CBD',
    taxRegistration: '12 345 678 901',
    timezone: 'Australia/Sydney',
    issuedAt: new Date('2026-10-18T03:04:00Z'),
    ...extra,
  });

describe('decideReceipt: which receipt, and what it is called', () => {
  const sale = completedSale();
  it('picks the natural kind from the order', () => {
    expect(naturalKind({ status: 'completed', kind: 'retail_sale' })).toBe('sale');
    expect(naturalKind({ status: 'completed', kind: 'return' })).toBe('refund');
    expect(naturalKind({ status: 'completed', kind: 'exchange' })).toBe('refund');
    expect(naturalKind({ status: 'voided', kind: 'retail_sale' })).toBe('void');
    expect(naturalKind({ status: 'cancelled', kind: 'dine_in' })).toBe('void');
    for (const status of ['draft', 'open', 'suspended'] as const)
      expect(naturalKind({ status, kind: 'dine_in' })).toBe('proforma');
  });

  it('numbers by business date and canonical number; checks, gift, proforma and void get a suffix', () => {
    const check = sale.checks[0]!;
    expect(decideReceipt(sale, undefined, null, [])).toMatchObject({
      kind: 'sale',
      number: '20261018-0042',
      isReprint: false,
      copyNumber: 1,
    });
    expect(decideReceipt(sale, 'sale', check.id, []).number).toBe('20261018-0042-C1');
    expect(decideReceipt(sale, 'gift', null, []).number).toBe('20261018-0042-G');
    const draft = {
      ...sale,
      status: 'open' as const,
      orderNumber: null,
      id: 'abcdefgh-1234-5678-9012-3456789abcde',
    } as OrderState;
    expect(decideReceipt(draft, undefined, null, []).number).toBe(
      'PF-3456789abcde'.slice(0, 3) + draft.id.slice(-8) + '-P',
    ); // not placed yet: no canonical number
    expect(decideReceipt({ ...sale, status: 'voided' }, undefined, null, []).number).toBe(
      '20261018-0042-V',
    );
  });

  it('asking again for a sale, refund or void is a reprint with its own number and copy count; scopes are separate', () => {
    const check = sale.checks[0]!;
    const first = [{ kind: 'sale', checkId: null }];
    expect(decideReceipt(sale, undefined, null, first)).toMatchObject({
      kind: 'reprint',
      baseKind: 'sale',
      isReprint: true,
      copyNumber: 2,
      number: '20261018-0042-R1',
    });
    const second = [...first, { kind: 'reprint', checkId: null }];
    expect(decideReceipt(sale, 'sale', null, second)).toMatchObject({
      kind: 'reprint',
      copyNumber: 3,
      number: '20261018-0042-R2',
    });
    // a receipt for one check is a different scope from the whole order
    expect(decideReceipt(sale, 'sale', check.id, first)).toMatchObject({
      kind: 'sale',
      isReprint: false,
      number: '20261018-0042-C1',
    });
    expect(
      decideReceipt(sale, 'sale', check.id, [...first, { kind: 'sale', checkId: check.id }]).number,
    ).toBe('20261018-0042-C1-R1');
    // gift and proforma are never "reprints": each request is its own document
    expect(decideReceipt(sale, 'gift', null, [{ kind: 'gift', checkId: null }])).toMatchObject({
      kind: 'gift',
      isReprint: false,
    });
    expect(
      decideReceipt({ ...sale, status: 'open' }, 'proforma', null, [
        { kind: 'proforma', checkId: null },
      ]).isReprint,
    ).toBe(false);
  });

  it('refuses a document the order cannot support', () => {
    const open = { ...sale, status: 'open' as const };
    const fail = (o: OrderState, kind: orders.ReceiptKind | undefined) => () =>
      decideReceipt(o, kind, null, []);
    expect(fail(open, 'sale')).toThrow(ReceiptNotAvailable);
    expect(fail(sale, 'refund')).toThrow(ReceiptNotAvailable); // not a return
    expect(fail({ ...sale, kind: 'return' }, 'sale')).toThrow(ReceiptNotAvailable);
    expect(fail(sale, 'void')).toThrow(ReceiptNotAvailable);
    expect(fail(open, 'gift')).toThrow(ReceiptNotAvailable);
    expect(fail({ ...sale, status: 'voided' }, 'proforma')).toThrow(ReceiptNotAvailable);
    expect(fail(sale, 'reprint')).toThrow(ReceiptNotAvailable);
    expect(fail(sale, 'sale')).not.toThrow();
  });
});

describe('PDF renderer', () => {
  const layout = (o = completedSale()) => orders.layoutReceipt(model(o));
  const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

  it('is a well-formed single-page PDF: header, objects, xref offsets that point at the objects, trailer', () => {
    const pdf = renderReceiptPdf(layout());
    const s = text(pdf);
    expect(s.startsWith('%PDF-1.4\n')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(s)![1]);
    expect(s.slice(startxref, startxref + 4)).toBe('xref');
    const offsets = [...s.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
      Number(m[1]),
    );
    expect(offsets).toHaveLength(6);
    offsets.forEach((offset, i) =>
      expect(s.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`),
    );
    expect(s).toContain('/BaseFont /Courier');
    expect(s).toContain('/Type /Page ');
    const length = Number(/\/Length (\d+)/.exec(s)![1]);
    const streamStart = s.indexOf('stream\n') + 'stream\n'.length;
    expect(s.slice(streamStart, streamStart + length).endsWith('ET')).toBe(true);
  });

  it('carries the receipt text, escapes PDF string syntax and stays deterministic', () => {
    const o = completedSale('Beans (1kg) \\ "special"', 2500n);
    const a = text(renderReceiptPdf(layout(o)));
    expect(a).toContain('Beans \\(1kg\\) \\\\ "special"');
    expect(a).toContain('(TOTAL');
    expect(a).toContain('Courier-Bold');
    expect(renderReceiptPdf(layout(o))).toEqual(renderReceiptPdf(layout(o)));
    // a narrow roll gets a narrower page
    const wide = /MediaBox \[0 0 (\d+)/.exec(text(renderReceiptPdf(layout(o), 48)))![1];
    const narrow = /MediaBox \[0 0 (\d+)/.exec(
      text(renderReceiptPdf(orders.layoutReceipt(model(o), 32), 32)),
    )![1];
    expect(Number(narrow)).toBeLessThan(Number(wide));
  });
});

describe('HTML renderer', () => {
  it('escapes every dynamic string and shows the GST contained in the total', () => {
    const o = completedSale('<img src=x onerror=alert(1)> & "Co"', 1100n);
    const html = renderReceiptHtml(
      model(o, 'sale', { header: '<b>Welcome</b>', businessName: '<script>x</script> Pty' }),
    );
    expect(html).not.toMatch(/<img|<script>|<b>Welcome/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;');
    expect(html).toContain('&lt;b&gt;Welcome&lt;/b&gt;');
    expect(html).toContain('Total includes GST $1.00');
    expect(html).toContain('<h2>TAX INVOICE</h2>');
    expect(html).toContain('ABN 12 345 678 901');
    expect(html).not.toMatch(/https?:\/\//); // no external requests
  });

  it('marks reprints, proformas and voids; exclusive pricing prints a tax line, not "includes"', () => {
    const o = completedSale();
    expect(renderReceiptHtml(model(o, 'reprint', { copyNumber: 3 }))).toContain(
      '*** REPRINT - COPY 3 ***',
    );
    expect(renderReceiptHtml(model(o, 'proforma'))).toContain('NOT A TAX INVOICE');
    expect(renderReceiptHtml(model(o, 'void'))).toContain('*** ORDER VOIDED ***');
    const c = ctx();
    let ex = orders.createOrder(
      {
        tenantId: 't',
        locationId: 'l',
        businessDate: '2026-10-18',
        kind: 'retail_sale',
        currency: 'AUD',
        pricingMode: 'tax_exclusive',
      },
      c,
    ).state;
    ex = orders.addLine(ex, { snapshot: snap('Pen', 1000n), quantity: '1' }, c).state;
    const html = renderReceiptHtml(model(ex, 'proforma'));
    expect(html).toContain('<td>Tax</td><td class="r">$1.00</td>');
    expect(html).not.toContain('Total includes');
  });
});

describe('model JSON round trip', () => {
  it('keeps bigint amounts exact so any paper width can be laid out later', () => {
    const m = model(completedSale('Big ticket', 9_007_199_254_740_993n));
    const back = parseModel(serializeModel(m));
    expect(back.total.minor).toBe(9_007_199_254_740_993n);
    expect(back).toEqual(m);
    expect(orders.layoutReceipt(back, 32).length).toBeGreaterThan(5);
  });
});

describe('LocalDiskObjectStore (the stub for MinIO)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pos-store-test-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stores and returns bytes with their content type, overwrites, and reports missing keys as null', async () => {
    const store = new LocalDiskObjectStore(dir);
    const key = 'receipts/t1/o1/r1.pdf';
    expect(await store.get(key)).toBeNull();
    const put = await store.put(key, Uint8Array.from([1, 2, 3]), 'application/pdf');
    expect(put).toEqual({ uri: `local://${key}`, bytes: 3 });
    expect(store.uriFor(key)).toBe(`local://${key}`);
    const got = await store.get(key);
    expect([...got!.body]).toEqual([1, 2, 3]);
    expect(got!.contentType).toBe('application/pdf');
    await store.put(key, Uint8Array.from([9]), 'application/octet-stream');
    expect([...(await store.get(key))!.body]).toEqual([9]);
    expect((await readdir(join(dir, 'receipts/t1/o1'))).sort()).toEqual(['r1.pdf', 'r1.pdf.meta']);
  });

  it('refuses keys that could leave the store', async () => {
    const store = new LocalDiskObjectStore(dir);
    for (const bad of [
      '../etc/passwd',
      'a/../../b',
      '/abs',
      'a//b',
      './a',
      'a/./b',
      '',
      'a b',
      'a\\b',
      '.hidden',
      'a/..',
    ]) {
      expect(() => assertSafeKey(bad), bad).toThrow(TypeError);
      await expect(store.put(bad, new Uint8Array(), 'x/y')).rejects.toThrow(TypeError);
      await expect(store.get(bad)).rejects.toThrow(TypeError);
    }
    expect(() => assertSafeKey('receipts/a-b_c/1.2.pdf')).not.toThrow();
  });
});
