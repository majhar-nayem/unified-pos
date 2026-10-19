import { spawnSync } from 'node:child_process';
import { access, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { OrderDto, ReceiptDto, ReceiptRenderDto } from '@pos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditActions,
  buildOrdersWorld,
  client,
  ifMatch,
  line,
  port,
  type OrdersWorld,
} from '../orders/public/testing.js';

describe('receipts: templates, tax breakdown, object store, reprint logging (F4)', () => {
  let w: OrdersWorld;
  beforeAll(async () => {
    w = await buildOrdersWorld();
  }, 240_000);
  afterAll(async () => {
    await w?.close();
  });

  const cashier = () => client(w, w.cashier.token);
  const manager = () => client(w, w.manager.token);
  const owner = () => client(w, w.ownerToken);

  const completed = async (
    lines: Array<ReturnType<typeof line>>,
    extra: Record<string, unknown> = {},
  ): Promise<OrderDto> => {
    const draft = await owner().create({ lines, ...extra });
    await port(w).settle(await owner().place(draft));
    return owner().get_(draft.id);
  };
  const issue = async (c: ReturnType<typeof client>, orderId: string, body: object = {}) =>
    (await c.post(`/orders/${orderId}/receipts`, body).expect(201)).body as ReceiptDto;
  const render = async (
    c: ReturnType<typeof client>,
    orderId: string,
    receiptId: string,
    query = 'format=html',
  ) =>
    (await c.get(`/orders/${orderId}/receipts/${receiptId}/render?${query}`).expect(200))
      .body as ReceiptRenderDto;
  const storeFiles = async (order: OrderDto) =>
    readdir(join(w.objectStoreDir, 'receipts', w.tenantId, order.id)).catch(() => [] as string[]);

  it('a sale receipt: tax breakdown for inclusive pricing, legal entity ABN, stored in the object store in four renders', async () => {
    const order = await completed([line('Latte', '550', '2'), line('Muffin', '450')]);
    const receipt = await issue(cashier(), order.id, { deliveredVia: ['print', 'email'] });
    expect(receipt).toMatchObject({
      orderId: order.id,
      checkId: null,
      kind: 'sale',
      templateKey: 'receipt.standard',
      deliveredVia: ['print', 'email'],
      printedBy: w.cashier.id,
    });
    expect(receipt.number).toBe(
      `${order.businessDate.replaceAll('-', '')}-${String(order.orderNumber).padStart(4, '0')}`,
    );
    expect(receipt.renderedUri).toBe(
      `local://receipts/${w.tenantId}/${order.id}/${receipt.id}.pdf`,
    );

    const html = (await render(cashier(), order.id, receipt.id)).content;
    expect(html).toContain('<h2>TAX INVOICE</h2>');
    expect(html).toContain('Acme Coffee Pty Ltd');
    expect(html).toContain('ABN 12 345 678 901');
    expect(html).toContain('Total includes GST $1.41'); // 100 + 41 contained in $15.50
    expect(html).toContain('$15.50');
    expect(html).toContain('GST 10%</td><td class="r">$14.09</td><td class="r">$1.41</td>'); // taxable amount and tax per rate
    expect(html).toContain('Prices include GST. Returns within 30 days');
    expect(html).toContain('2 × Latte');

    const text = await render(cashier(), order.id, receipt.id, 'format=text');
    expect(text).toMatchObject({ contentType: 'text/plain; charset=utf-8', encoding: 'utf8' });
    expect(text.content).toContain('Total includes GST');
    for (const l of text.content.split('\n')) expect(l.length).toBeLessThanOrEqual(48);
    const narrow = await render(cashier(), order.id, receipt.id, 'format=text&columns=32');
    for (const l of narrow.content.split('\n')) expect(l.length).toBeLessThanOrEqual(32);
    expect(narrow.content).toContain('$15.50');

    const escpos = await render(cashier(), order.id, receipt.id, 'format=escpos');
    const bytes = Buffer.from(escpos.content, 'base64');
    expect(escpos).toMatchObject({ contentType: 'application/octet-stream', encoding: 'base64' });
    expect([...bytes.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    expect([...bytes.subarray(-4)]).toEqual([0x1d, 0x56, 0x42, 0x00]);
    expect(bytes.toString('latin1')).toContain('Latte');
    const escposNarrow = Buffer.from(
      (await render(cashier(), order.id, receipt.id, 'format=escpos&columns=32')).content,
      'base64',
    );
    expect(escposNarrow.length).not.toBe(bytes.length);

    const pdf = Buffer.from(
      (await render(cashier(), order.id, receipt.id, 'format=pdf')).content,
      'base64',
    );
    expect(pdf.subarray(0, 8).toString()).toBe('%PDF-1.4');
    expect(pdf.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
    if (spawnSync('pdftotext', ['-v']).error === undefined) {
      // a real PDF reader agrees the file is valid and says what we printed
      const pdfPath = join(w.objectStoreDir, 'receipts', w.tenantId, order.id, `${receipt.id}.pdf`);
      const read = spawnSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' });
      expect(read.status).toBe(0);
      expect(read.stdout).toContain('TAX INVOICE');
      expect(read.stdout).toContain('$15.50');
    }

    expect((await storeFiles(order)).filter((f) => !f.endsWith('.meta')).sort()).toEqual(
      ['json', 'pdf', 'html', 'txt', 'escpos'].map((ext) => `${receipt.id}.${ext}`).sort(),
    );
    const list = (await cashier().get(`/orders/${order.id}/receipts`).expect(200))
      .body as ReceiptDto[];
    expect(list.map((r) => r.id)).toEqual([receipt.id]);
    expect(
      (await cashier().get(`/orders/${order.id}/receipts/${receipt.id}`).expect(200)).body,
    ).toEqual(receipt);
    const rows = await w.db.admin.query('SELECT 1 FROM orders.receipts WHERE order_id = $1', [
      order.id,
    ]);
    expect(rows.rowCount).toBe(1);
  });

  it('mixed GST and GST-free items, a service charge and a line discount all land in the breakdown', async () => {
    const draft = await owner().create({
      lines: [
        line('Coffee', '1100'),
        line('Bread', '450', '1', { item: { name: 'Bread', taxClassCode: 'gst_free' } }),
      ],
    });
    const charged = (
      await owner()
        .post(
          `/orders/${draft.id}/charges`,
          { kind: 'surcharge', description: 'Public holiday', amountMinor: '220' },
          ifMatch(draft),
        )
        .expect(200)
    ).body as OrderDto;
    await port(w).settle(await owner().place(charged));
    const order = await owner().get_(draft.id);
    expect(order).toMatchObject({ totalMinor: '1770', taxMinor: '120' });
    const html = (await render(owner(), order.id, (await issue(owner(), order.id)).id)).content;
    expect(html).toContain('GST 10%</td><td class="r">$12.00</td><td class="r">$1.20</td>'); // line GST + GST on the surcharge, same rate
    expect(html).toContain('GST Free 0%</td><td class="r">$4.50</td><td class="r">$0.00</td>');
    expect(html).toContain('Total includes GST $1.20');
    expect(html).toContain('Public holiday');
  });

  it('item names and the header cannot inject markup', async () => {
    await w
      .api()
      .put('/v1/config')
      .set(owner().auth)
      .set(w.idem())
      .send({
        key: 'receipt.header',
        scopeKind: 'location',
        scopeId: w.locationA,
        value: '<script>steal()</script> Thanks!',
      })
      .expect(200);
    const order = await completed([line('<img src=x onerror=alert(1)>', '1100')]);
    const html = (await render(owner(), order.id, (await issue(owner(), order.id)).id)).content;
    expect(html).not.toMatch(/<img src|<script>steal/);
    expect(html).toContain('&lt;script&gt;steal()&lt;/script&gt; Thanks!');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('asking again for a receipt is a logged reprint: its own row and number, orders.receipt.reprint required, audit and order history', async () => {
    const order = await completed([line('Jacket', '12000')]);
    const first = await issue(cashier(), order.id);
    expect(first.kind).toBe('sale');
    // a cashier may issue the first receipt but not reprint it
    const denied = await cashier().post(`/orders/${order.id}/receipts`, {}).expect(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    expect(
      (await cashier().get(`/orders/${order.id}/receipts`).expect(200)).body as ReceiptDto[],
    ).toHaveLength(1);

    const second = await issue(manager(), order.id);
    const third = await issue(manager(), order.id, { kind: 'sale', deliveredVia: ['email'] });
    expect([second.kind, third.kind]).toEqual(['reprint', 'reprint']);
    expect(second.number).toBe(`${first.number}-R1`);
    expect(third.number).toBe(`${first.number}-R2`);
    expect(third).toMatchObject({ printedBy: w.manager.id, deliveredVia: ['email'] });
    expect((await render(manager(), order.id, second.id, 'format=text')).content).toContain(
      '*** REPRINT - COPY 2 ***',
    );
    expect((await render(manager(), order.id, third.id, 'format=text')).content).toContain(
      '*** REPRINT - COPY 3 ***',
    );
    expect((await render(manager(), order.id, first.id, 'format=text')).content).not.toContain(
      'REPRINT',
    );
    // a reprint of a sale is still a tax invoice
    expect((await render(manager(), order.id, second.id)).content).toContain(
      '<h2>TAX INVOICE</h2>',
    );

    const rows = await w.db.admin.query<{ kind: string; number: string }>(
      'SELECT kind, number FROM orders.receipts WHERE order_id = $1 ORDER BY id',
      [order.id],
    );
    expect(rows.rows.map((r) => r.kind)).toEqual(['sale', 'reprint', 'reprint']);
    const actions = (await auditActions(w, second.id)).concat(await auditActions(w, first.id));
    expect(actions.map((a) => a.action).sort()).toEqual([
      'orders.receipt.issued',
      'orders.receipt.reprinted',
    ]);
    const events = (await owner().get(`/orders/${order.id}/events`).expect(200)).body as Array<{
      kind: string;
      payload: { receiptId?: string; copyNumber?: number };
    }>;
    expect(
      events
        .filter((e) => e.kind.startsWith('receipt_'))
        .map((e) => [e.kind, e.payload.copyNumber]),
    ).toEqual([
      ['receipt_issued', 1],
      ['receipt_reprinted', 2],
      ['receipt_reprinted', 3],
    ]);
  });

  it('proforma before payment, gift receipt without prices, void receipt after a void, and refusals for documents the order cannot support', async () => {
    const draft = await owner().create({ lines: [line('Scarf', '4000')] });
    const proforma = await issue(cashier(), draft.id);
    expect(proforma.kind).toBe('proforma');
    expect(proforma.number).toMatch(/^PF-.{8}-P$/);
    const html = (await render(cashier(), draft.id, proforma.id)).content;
    expect(html).toContain('NOT A TAX INVOICE');
    expect(html).not.toContain('<h2>TAX INVOICE</h2>');
    // another proforma is another document, not a reprint
    expect((await issue(cashier(), draft.id)).kind).toBe('proforma');
    const early = await cashier()
      .post(`/orders/${draft.id}/receipts`, { kind: 'sale' })
      .expect(409);
    expect(early.body.error.code).toBe('RECEIPT_NOT_AVAILABLE');
    await cashier().post(`/orders/${draft.id}/receipts`, { kind: 'gift' }).expect(409);

    const placed = await owner().place(draft);
    await port(w).settle(placed);
    const gift = await issue(cashier(), draft.id, { kind: 'gift' });
    expect(gift.number).toMatch(/-G$/);
    const giftHtml = (await render(cashier(), draft.id, gift.id)).content;
    expect(giftHtml).toContain('GIFT RECEIPT');
    expect(giftHtml).toContain('Scarf');
    expect(giftHtml).not.toMatch(/\$40\.00|\$36\.36|\$3\.64/);
    await cashier().post(`/orders/${draft.id}/receipts`, { kind: 'void' }).expect(409);
    await cashier().post(`/orders/${draft.id}/receipts`, { kind: 'refund' }).expect(409);

    const done = await owner().get_(draft.id);
    await manager()
      .post(`/orders/${draft.id}/void`, { reason: 'wrong customer' }, ifMatch(done))
      .expect(200);
    const voided = await issue(manager(), draft.id);
    expect(voided.kind).toBe('void');
    expect(voided.number).toMatch(/-V$/);
    expect((await render(manager(), draft.id, voided.id)).content).toContain(
      '*** ORDER VOIDED ***',
    );
    await manager().post(`/orders/${draft.id}/receipts`, { kind: 'proforma' }).expect(409);
  });

  it('a receipt for one check shows only that check; a refund receipt for a return shows negative amounts', async () => {
    const draft = await owner().create({
      kind: 'dine_in',
      lines: [
        line('Steak', '3300', '1', { seatNumber: 1 }),
        line('Salad', '1100', '1', { seatNumber: 2 }),
      ],
    });
    const split = (
      await owner()
        .post(
          `/orders/${draft.id}/checks/split`,
          { mode: 'seats', fromCheckId: draft.checks[0]!.id, seatNumbers: [2] },
          ifMatch(draft),
        )
        .expect(200)
    ).body as OrderDto;
    const placed = await owner().place(split);
    await port(w).applyPayment({
      orderId: draft.id,
      checkId: placed.checks[1]!.id,
      amountMinor: 1100n,
      paymentRef: 'salad',
    });
    const receipt = await issue(cashier(), draft.id, {
      kind: 'proforma',
      checkId: placed.checks[1]!.id,
    });
    expect(receipt.checkId).toBe(placed.checks[1]!.id);
    expect(receipt.number).toMatch(/-C2-P$/);
    const html = (await render(cashier(), draft.id, receipt.id)).content;
    expect(html).toContain('Salad');
    expect(html).not.toContain('Steak');
    expect(html).toContain('check 2');
    expect(html).toContain('Total includes GST $1.00');
    await cashier()
      .post(`/orders/${draft.id}/receipts`, {
        kind: 'proforma',
        checkId: '00000000-0000-4000-8000-000000000000',
      })
      .expect(422);

    const sale = await completed([line('Widget', '1100')]);
    const ret = (
      await manager()
        .post(`/orders/${sale.id}/returns`, {
          lines: [{ sourceLineId: sale.lines[0]!.id, quantity: '1' }],
        })
        .expect(201)
    ).body as OrderDto;
    const retPlaced = await manager().place(ret);
    await port(w).applyPayment({ orderId: ret.id, amountMinor: -1100n, paymentRef: 'rf' });
    await port(w).markPaid({ orderId: ret.id });
    expect(retPlaced.status).toBe('open');
    const refund = await issue(manager(), ret.id);
    expect(refund.kind).toBe('refund');
    const refundText = (await render(manager(), ret.id, refund.id, 'format=text')).content;
    expect(refundText).toContain('REFUND');
    expect(refundText).toMatch(/TOTAL\s+-\$11\.00/);
    expect(refundText).toContain('-$1.00'); // the GST handed back
  });

  it('stored receipts are frozen; a missing stored file is reported, not regenerated', async () => {
    const order = await completed([line('Mug', '1100')]);
    const receipt = await issue(owner(), order.id);
    const before = (await render(owner(), order.id, receipt.id, 'format=text')).content;
    await port(w).applyRefund({ orderId: order.id, amountMinor: 500n, paymentRef: 'rf-after' });
    expect(await render(owner(), order.id, receipt.id, 'format=text')).toMatchObject({
      content: before,
    });
    const later = await issue(manager(), order.id);
    expect(later.kind).toBe('reprint');
    expect((await render(manager(), order.id, later.id, 'format=text')).content).toContain(
      'Refunded',
    );
    expect(before).not.toContain('Refunded');

    await rm(join(w.objectStoreDir, 'receipts', w.tenantId, order.id, `${receipt.id}.pdf`));
    const gone = await owner()
      .get(`/orders/${order.id}/receipts/${receipt.id}/render?format=pdf`)
      .expect(410);
    expect(gone.body.error.code).toBe('RECEIPT_CONTENT_GONE');
    expect((await render(owner(), order.id, receipt.id)).content).toContain('Mug'); // the other renders are intact
    await writeFile(join(w.objectStoreDir, 'sentinel'), 'x');
    await expect(access(join(w.objectStoreDir, 'sentinel'))).resolves.toBeUndefined();
  });

  it('validation and isolation: unknown template, bad format, another tenant, another order’s receipt', async () => {
    const order = await completed([line('Pen', '300')]);
    const other = await completed([line('Ink', '900')]);
    const receipt = await issue(owner(), order.id);
    const unknown = await owner()
      .post(`/orders/${order.id}/receipts`, { templateKey: 'receipt.fancy' })
      .expect(422);
    expect(unknown.body.error.code).toBe('TEMPLATE_UNKNOWN');
    await owner().post(`/orders/${order.id}/receipts`, { kind: 'reprint' }).expect(422);
    await owner().get(`/orders/${order.id}/receipts/${receipt.id}/render?format=docx`).expect(422);
    await owner()
      .get(`/orders/${order.id}/receipts/${receipt.id}/render?format=text&columns=5`)
      .expect(422);
    await owner().get(`/orders/${other.id}/receipts/${receipt.id}`).expect(404); // a receipt belongs to its order
    await owner().get(`/orders/${other.id}/receipts/${receipt.id}/render`).expect(404);
    const f = client(w, w.foreign.token);
    await f.get(`/orders/${order.id}/receipts`).expect(404);
    await f.get(`/orders/${order.id}/receipts/${receipt.id}`).expect(404);
    await f.get(`/orders/${order.id}/receipts/${receipt.id}/render`).expect(404);
    await f.post(`/orders/${order.id}/receipts`, {}).expect(404);
    // a cashier at the other location cannot reach it either
    const b = client(w, w.cashierB.token);
    await b.get(`/orders/${order.id}/receipts`).expect(404);
    await b.post(`/orders/${order.id}/receipts`, {}).expect(404);
  });
});
