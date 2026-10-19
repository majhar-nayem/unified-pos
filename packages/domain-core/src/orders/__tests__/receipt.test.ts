import { describe, expect, it } from 'vitest';

import { addCharge } from '../discounts.js';
import { splitCheckBySeat } from '../checks.js';
import { addLine } from '../lines.js';
import { place } from '../lifecycle.js';
import { applyPayment, markPaid } from '../payments.js';
import {
  type ReceiptBuildContext,
  buildReceiptModel,
  formatLocal,
  formatMoney,
  layoutReceipt,
  renderEscPos,
  renderPlainText,
  toPrinterText,
} from '../receipt.js';
import { buildReturnOrder, placeReturn } from '../returns.js';
import { OrderRuleError } from '../types.js';
import { add, draft, makeCtx, snapshot, withLines } from './helpers.js';

const base: ReceiptBuildContext = {
  kind: 'sale',
  number: '20261018-0001',
  businessName: 'Acme Coffee Pty Ltd',
  locationName: 'Acme Sydney CBD',
  addressLines: ['1 George St', 'Sydney NSW 2000'],
  taxRegistration: '12 345 678 901',
  header: 'Thanks for visiting!',
  legalText: 'Prices include GST. Returns within 30 days with receipt.',
  timezone: 'Australia/Sydney',
  issuedAt: new Date('2026-10-18T03:04:00Z'),
};

const paid = (o: ReturnType<typeof withLines>, ctx = makeCtx()) => {
  const placed = place(o, { orderNumber: 42 }, ctx).state;
  return markPaid(
    applyPayment(placed, { amountMinor: placed.totalMinor, paymentRef: 'p' }, ctx).state,
    ctx,
  ).state;
};

describe('tax breakdown (GST inclusive)', () => {
  it('shows the GST contained in the total and a breakdown that adds up', () => {
    const ctx = makeCtx();
    const order = paid(
      withLines(ctx, [
        ['Latte', 550n, '2'],
        ['Muffin', 550n],
      ]),
      ctx,
    );
    const m = buildReceiptModel(order, base);
    expect(m).toMatchObject({
      title: 'Tax Invoice',
      pricing: 'inclusive',
      orderNumber: '0042',
      issuedAt: '18/10/2026 14:04',
    });
    expect(m.tax).toHaveLength(1);
    expect(m.tax[0]).toMatchObject({ name: 'GST', rate: '10%' });
    expect(m.tax[0]!.taxable.minor).toBe(1500n);
    expect(m.tax[0]!.tax.minor).toBe(150n);
    expect(m.taxTotal.minor).toBe(150n);
    expect(m.total.minor).toBe(1650n);
    // inclusive: taxable + tax = total
    expect(m.tax[0]!.taxable.minor + m.tax[0]!.tax.minor).toBe(m.total.minor);
    const text = renderPlainText(layoutReceipt(m));
    expect(text).toContain('Total includes GST');
    expect(text).toContain('$1.50');
    expect(text).toContain('ABN 12 345 678 901');
    expect(text).toContain('TAX INVOICE');
    expect(text).toContain('2 x Latte');
    expect(text).toContain('$16.50');
  });

  it('without a tax registration the document is just a receipt', () => {
    const ctx = makeCtx();
    const m = buildReceiptModel(paid(withLines(ctx, [['A', 1100n]]), ctx), {
      ...base,
      taxRegistration: null,
    });
    expect(m.title).toBe('Receipt');
    expect(renderPlainText(layoutReceipt(m))).not.toContain('ABN');
  });

  it('mixed GST and GST-free items give one row per rate', () => {
    const ctx = makeCtx();
    let o = draft(ctx);
    o = add(o, ctx, 'Coffee', 1100n).state;
    o = addLine(
      o,
      { snapshot: snapshot('Bread', 450n, { taxClassCode: 'gst_free' }), quantity: '1' },
      ctx,
    ).state;
    const m = buildReceiptModel(paid(o, ctx), base);
    expect(m.tax.map((r) => [r.name, r.rate, r.taxable.minor, r.tax.minor])).toEqual([
      ['GST', '10%', 1000n, 100n],
      ['GST Free', '0%', 450n, 0n],
    ]);
    expect(m.taxTotal.minor).toBe(100n);
  });

  it('tax on charges joins the single taxed rate', () => {
    const ctx = makeCtx();
    let o = withLines(ctx, [['A', 1100n]]);
    o = addCharge(
      o,
      { kind: 'surcharge', description: 'Public holiday', amountMinor: 220n },
      ctx,
    ).state;
    const m = buildReceiptModel(paid(o, ctx), base);
    expect(m.tax).toHaveLength(1);
    expect(m.tax[0]!.tax.minor).toBe(100n + 20n);
    expect(m.tax[0]!.taxable.minor).toBe(1000n + 200n);
    expect(m.taxTotal.minor).toBe(m.tax[0]!.tax.minor);
    expect(m.charges[0]).toMatchObject({ description: 'Public holiday' });
    expect(m.total.minor).toBe(1320n);
  });

  it('exclusive pricing prints the tax as its own line', () => {
    const ctx = makeCtx();
    const m = buildReceiptModel(
      paid(withLines(ctx, [['A', 1000n]], { pricingMode: 'tax_exclusive' }), ctx),
      base,
    );
    expect(m.pricing).toBe('exclusive');
    expect(m.lines[0]!.total.minor).toBe(1000n);
    expect(m.tax[0]).toMatchObject({ taxable: { minor: 1000n }, tax: { minor: 100n } });
    expect(m.total.minor).toBe(1100n);
    const text = renderPlainText(layoutReceipt(m));
    expect(text).toMatch(/Tax\s+\$1\.00/);
    expect(text).not.toContain('Total includes');
  });
});

describe('receipt variants', () => {
  it('a receipt for one check lists only its lines and totals', () => {
    const ctx = makeCtx();
    let o = draft(ctx, { kind: 'dine_in' });
    o = add(o, ctx, 'Steak', 3000n, '1', { seatNumber: 1 }).state;
    o = add(o, ctx, 'Salad', 1100n, '1', { seatNumber: 2 }).state;
    o = splitCheckBySeat(o, { fromCheckId: o.checks[0]!.id, seatNumbers: [2] }, ctx).state;
    o = place(o, { orderNumber: 7 }, ctx).state;
    const m = buildReceiptModel(o, { ...base, checkId: o.checks[1]!.id });
    expect(m.lines.map((l) => l.name)).toEqual(['Salad']);
    expect(m).toMatchObject({ checkNumber: 2 });
    expect(m.total.minor).toBe(1100n);
    expect(m.due.minor).toBe(1100n);
    expect(m.taxTotal.minor).toBe(100n);
    expect(() => buildReceiptModel(o, { ...base, checkId: 'nope' })).toThrow(OrderRuleError);
  });

  it('a refund shows negative amounts', () => {
    const ctx = makeCtx();
    const src = paid(withLines(ctx, [['Mug', 1100n]]), ctx);
    const placed = placeReturn(
      buildReturnOrder(
        src,
        {
          kind: 'return',
          lines: [{ sourceLineId: src.lines[0]!.id, quantity: '1' }],
          businessDate: '2026-10-19',
        },
        ctx,
      ).state,
      src,
      { orderNumber: 1 },
      ctx,
    ).state;
    const m = buildReceiptModel(placed, { ...base, kind: 'refund' });
    expect(m.title).toBe('Refund');
    expect(m.total.text).toBe('-$11.00');
    expect(m.taxTotal.minor).toBe(-100n);
    expect(m.lines[0]!.isReturn).toBe(true);
  });

  it('a gift receipt shows no prices and no tax', () => {
    const ctx = makeCtx();
    const m = buildReceiptModel(paid(withLines(ctx, [['Scarf', 4000n]]), ctx), {
      ...base,
      kind: 'gift',
    });
    expect(m.title).toBe('Gift Receipt');
    expect(m.total.minor).toBe(0n);
    expect(m.tax).toEqual([]);
    expect(renderPlainText(layoutReceipt(m))).not.toContain('40.00');
  });

  it('a reprint is marked, numbered and a proforma says it is not a tax invoice', () => {
    const ctx = makeCtx();
    const order = paid(withLines(ctx, [['A', 1100n]]), ctx);
    const reprint = renderPlainText(
      layoutReceipt(buildReceiptModel(order, { ...base, kind: 'reprint', copyNumber: 2 })),
    );
    expect(reprint).toContain('*** REPRINT - COPY 2 ***');
    const proforma = renderPlainText(
      layoutReceipt(buildReceiptModel(order, { ...base, kind: 'proforma' })),
    );
    expect(proforma).toContain('NOT A TAX INVOICE');
    expect(
      renderPlainText(layoutReceipt(buildReceiptModel(order, { ...base, kind: 'void' }))),
    ).toContain('*** ORDER VOIDED ***');
  });

  it('shows modifiers, line discounts and the register reference', () => {
    const ctx = makeCtx();
    let o = draft(ctx, { clientOrderRef: 'R1-000123' });
    o = add(o, ctx, 'Burger', 1000n, '1', {
      modifiers: [{ name: 'Bacon', priceDeltaMinor: 200n }, { name: 'No onion' }],
      notes: 'well done',
    }).state;
    const m = buildReceiptModel(paid(o, ctx), base);
    const text = renderPlainText(layoutReceipt(m));
    expect(text).toContain('+ Bacon');
    expect(text).toContain('+ No onion');
    expect(text).toContain('Note: well done');
    expect(text).toContain('R1-000123');
  });
});

describe('layouts', () => {
  const order = () => {
    const ctx = makeCtx();
    return paid(
      withLines(ctx, [
        ['A very long product name that will not fit on a narrow roll', 1100n, '3'],
        ['Café crème', 550n],
      ]),
      ctx,
    );
  };

  it.each([32, 42, 48])('plain text never exceeds %i columns', (columns) => {
    const text = renderPlainText(layoutReceipt(buildReceiptModel(order(), base), columns), columns);
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(columns);
    expect(text).toContain('Cafe creme'); // CP437-safe
  });

  it('ESC/POS: initialise, alignment, bold, feed and partial cut; printable ASCII only', () => {
    const bytes = renderEscPos(layoutReceipt(buildReceiptModel(order(), base)));
    expect([...bytes.slice(0, 2)]).toEqual([0x1b, 0x40]);
    expect([...bytes.slice(-4)]).toEqual([0x1d, 0x56, 0x42, 0x00]);
    const asText = [...bytes];
    expect(asText.join(',')).toContain([0x1b, 0x61, 1].join(',')); // centre
    expect(asText.join(',')).toContain([0x1b, 0x45, 1].join(',')); // bold on
    let controls = 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      if (b === 0x1b || b === 0x1d) controls++;
      else if (b > 0x7e) throw new Error(`non-ASCII byte ${b}`);
    }
    expect(controls).toBeGreaterThan(5);
    expect(Buffer.from(bytes).toString('latin1')).toContain('Cafe creme');
  });

  it('helpers format money, local time and printer text', () => {
    expect(formatMoney(1234n, 'AUD')).toBe('$12.34');
    expect(formatMoney(-5n, 'AUD')).toBe('-$0.05');
    expect(formatMoney(100n, 'EUR')).toBe('€1.00');
    expect(formatMoney(1000n, 'JPY')).toBe('¥1000');
    expect(formatMoney(100n, 'CHF')).toBe('CHF 1.00');
    expect(formatLocal(new Date('2026-10-18T13:30:00Z'), 'Australia/Sydney')).toBe(
      '19/10/2026 00:30',
    );
    expect(toPrinterText('Crème brûlée – 5 €“x”')).toBe('Creme brulee - 5 EUR "x"');
    expect(toPrinterText('日本')).toBe('??');
  });
});
