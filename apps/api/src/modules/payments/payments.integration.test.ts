import { randomUUID } from 'node:crypto';

import {
  type HierarchyFixture,
  createHierarchyFixture,
  startPostgresWithSchema,
  type TestPostgres,
} from '@pos/testing';
import { checkSchemaMirror, schema } from '@pos/db';
import { MockPaymentProvider } from '@pos/payments-sdk';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PaymentsLedger } from './ledger.service.js';
import { PaymentsRunner } from './payments-runner.js';
import { type OrderFixture, createOrderFixture, readOrder } from './testing/fixtures.js';
import {
  type PaymentsTestApp,
  WEBHOOK_SECRET,
  createPaymentsTestApp,
  paymentsPrincipal,
} from './testing/payments-test-app.js';

/**
 * F5 payments core against a real Postgres (RLS on, app role): the brief's invariants
 *   (a) no acknowledged payment is lost across a simulated crash,
 *   (b) an internal retry never charges twice,
 *   (c) an order is paid only when captured,
 * plus cash rounding, refunds, void/cancel, append-only events, redaction and tenant isolation.
 */
describe('payments core (F5)', () => {
  let db: TestPostgres;
  let t: PaymentsTestApp;
  let h: HierarchyFixture;
  let hB: HierarchyFixture;
  let owner: string;
  let ownerB: string;
  let locationMgr: string;
  let otherLocationMgr: string;
  let accountId: string; // auto capture
  let manualAccountId: string; // pre-auth, manual capture
  let terminalId: string;

  const api = () => supertest(t.server);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const post = (url: string, body: unknown = {}, token = owner) =>
    api()
      .post(url)
      .set(auth(token))
      .send(body as object);
  const get = (url: string, token = owner) => api().get(url).set(auth(token));
  const key = () => `ci-${randomUUID()}`;

  async function order(totalMinor: number, locationId = h.locationId): Promise<OrderFixture> {
    return createOrderFixture(db.admin, h.tenantId, locationId, totalMinor);
  }

  async function newIntent(
    o: OrderFixture,
    amountMinor: number,
    extra: Record<string, unknown> = {},
  ) {
    const res = await post('/v1/payments/intents', {
      locationId: o.locationId,
      orderId: o.orderId,
      checkId: o.checkId,
      clientIntentId: key(),
      method: 'card_not_present',
      amountMinor: String(amountMinor),
      providerAccountId: accountId,
      ...extra,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; status: string };
  }

  const submit = (id: string, body: unknown = {}, token = owner) =>
    post(`/v1/payments/intents/${id}/submit`, body, token);

  async function intentRow(id: string) {
    const { rows } = await db.admin.query('SELECT * FROM payments.payment_intents WHERE id = $1', [
      id,
    ]);
    return rows[0] as Record<string, unknown> & {
      status: string;
      captured_minor: bigint;
      refunded_minor: bigint;
      provider_reference: string | null;
    };
  }

  async function events(id: string): Promise<
    {
      kind: string;
      from_status: string | null;
      to_status: string | null;
      source: string;
      payload: Record<string, unknown>;
    }[]
  > {
    const { rows } = await db.admin.query(
      'SELECT kind, from_status, to_status, source, payload FROM payments.payment_events WHERE intent_id = $1 ORDER BY occurred_at, recorded_at',
      [id],
    );
    return rows;
  }

  async function outbox(type: string, aggregateId?: string): Promise<number> {
    const { rows } = await db.admin.query(
      `SELECT COUNT(*)::int AS n FROM audit.outbox_events WHERE event_type = $1 ${aggregateId ? 'AND aggregate_id = $2' : ''}`,
      aggregateId ? [type, aggregateId] : [type],
    );
    return rows[0].n as number;
  }

  /** Capture a card payment for `amount` on a fresh order; returns ids. */
  async function capturedPayment(amount: number) {
    const o = await order(amount);
    const intent = await newIntent(o, amount);
    const res = await submit(intent.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('captured');
    return { o, intent, ref: res.body.providerReference as string };
  }

  beforeAll(async () => {
    db = await startPostgresWithSchema();
    t = await createPaymentsTestApp({ databaseUrl: db.appUrl });
    h = await createHierarchyFixture(db.admin, 'pay-a');
    hB = await createHierarchyFixture(db.admin, 'pay-b');
    owner = t.auth.register(
      'owner-a',
      paymentsPrincipal(h.tenantId, { kind: 'tenant', id: h.tenantId }),
    );
    ownerB = t.auth.register(
      'owner-b',
      paymentsPrincipal(hB.tenantId, { kind: 'tenant', id: hB.tenantId }),
    );
    locationMgr = t.auth.register(
      'mgr-a',
      paymentsPrincipal(h.tenantId, { kind: 'location', id: h.locationId }),
    );
    otherLocationMgr = t.auth.register(
      'mgr-other',
      paymentsPrincipal(h.tenantId, { kind: 'location', id: h.otherLocationId }),
    );

    const auto = await post('/v1/payments/provider-accounts', {
      provider: 'mock',
      name: 'Mock acquirer',
      credentialsRef: 'mock/main',
      settings: {
        captureMode: 'auto',
        offline: { enabled: true, windowHours: 24, maxTransactionMinor: '50000' },
      },
      currencies: ['AUD'],
    });
    expect(auto.status, JSON.stringify(auto.body)).toBe(201);
    accountId = auto.body.id;
    const manual = await post('/v1/payments/provider-accounts', {
      provider: 'mock',
      name: 'Mock pre-auth',
      credentialsRef: 'mock/other',
      settings: { captureMode: 'manual' },
      currencies: ['AUD'],
    });
    manualAccountId = manual.body.id;
    const terminal = await post('/v1/payments/terminals', {
      locationId: h.locationId,
      providerAccountId: accountId,
      serialNumber: 'SN-1',
      connectionMode: 'lan',
    });
    expect(terminal.status, JSON.stringify(terminal.body)).toBe(201);
    terminalId = terminal.body.id;
    const paired = await post(`/v1/payments/terminals/${terminalId}/pair`, { code: '123456' });
    expect(paired.status, JSON.stringify(paired.body)).toBe(200);
  });

  afterAll(async () => {
    await t?.close();
    await db?.stop();
  });

  beforeEach(() => {
    t.faults.afterProviderCall = undefined;
    t.refundFaults.afterProviderCall = undefined;
  });

  // ---------------------------------------------------------------------------------------------

  describe('provider accounts and terminals', () => {
    it('stores credentials by reference only and reports the amended capability shape', async () => {
      const res = await get(`/v1/payments/provider-accounts/${accountId}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        provider: 'mock',
        credentialsRef: 'mock/main',
        simulated: true,
        capabilities: {
          offlineModes: { cloud: 'none', lan: 'local_terminal_api', sdk: 'sdk' },
          offlineExcludedSchemes: expect.arrayContaining(['amex']),
          leastCostRouting: true,
          certificationStatus: 'not_required',
        },
      });
    });

    it('rejects a secret pasted into credentialsRef and never stores unknown fields such as apiKey', async () => {
      const bad = await post('/v1/payments/provider-accounts', {
        provider: 'stripe',
        name: 'x',
        credentialsRef: 'sk_test_ 51Hx secret value',
      });
      expect(bad.status).toBe(422);
      const ok = await post('/v1/payments/provider-accounts', {
        provider: 'stripe',
        name: 'Stripe test',
        credentialsRef: 'stripe/test',
        apiKey: 'sk_test_do_not_store_me',
        status: 'pending',
      });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      expect(ok.body.simulated).toBe(true); // no STRIPE_SECRET_KEY in the test environment
      expect(JSON.stringify(ok.body)).not.toContain('do_not_store_me');
      const { rows } = await db.admin.query(
        'SELECT row_to_json(a)::text AS j FROM payments.payment_provider_accounts a WHERE id = $1',
        [ok.body.id],
      );
      expect(rows[0].j).not.toContain('do_not_store_me');
    });

    it('pairs a terminal and flags offline capability from its connection mode', async () => {
      const res = await get(`/v1/payments/terminals/${terminalId}`);
      expect(res.body).toMatchObject({
        status: 'paired',
        connectionMode: 'lan',
        offlineCapable: true,
      });
      const cloud = await post('/v1/payments/terminals', {
        locationId: h.locationId,
        providerAccountId: accountId,
        serialNumber: 'SN-CLOUD',
        connectionMode: 'cloud',
      });
      expect(cloud.body.offlineCapable).toBe(false); // cloud terminal API has no store-and-forward
      const wrong = await post(`/v1/payments/terminals/${cloud.body.id}/pair`, { code: '000000' });
      expect(wrong.status).toBe(409);
      expect(wrong.body.error.code).toBe('PAIRING_REJECTED');
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('cash tender: change and AUD 5c rounding recorded on the intent and the order', () => {
    it('rounds 1883 up to 1885, records change 115 on the captured event and the rounding on the order and check', async () => {
      const o = await order(1883);
      const clientIntentId = key();
      const res = await post('/v1/payments/cash-tenders', {
        locationId: o.locationId,
        orderId: o.orderId,
        checkId: o.checkId,
        clientIntentId,
        tenderedMinor: '2000',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({
        dueMinor: '1885',
        tenderedMinor: '2000',
        changeMinor: '115',
        roundingMinor: '2',
      });
      expect(res.body.intent).toMatchObject({
        method: 'cash',
        status: 'captured',
        amountMinor: '1885',
        capturedMinor: '1885',
        settlementStatus: 'not_applicable',
      });

      const stored = await readOrder(db.admin, o.orderId);
      expect(stored).toMatchObject({
        payment_status: 'paid',
        total_minor: 1885n,
        paid_minor: 1885n,
        rounding_minor: 2n,
        check_total: 1885n,
        check_paid: 1885n,
        check_rounding: 2n,
      });
      expect(stored.metadata.cashTenders?.[0]).toMatchObject({
        changeMinor: '115',
        tenderedMinor: '2000',
        roundingMinor: '2',
        intentId: res.body.intent.id,
      });

      const log = await events(res.body.intent.id);
      expect(log.map((e) => e.kind)).toEqual(['created', 'submitted', 'captured']);
      expect(log[2]!.payload).toMatchObject({
        tender: 'cash',
        outstandingMinor: '1883',
        dueMinor: '1885',
        changeMinor: '115',
        roundingMinor: '2',
      });

      // a replay of the same client key returns the same result and changes nothing
      const replay = await post('/v1/payments/cash-tenders', {
        locationId: o.locationId,
        orderId: o.orderId,
        checkId: o.checkId,
        clientIntentId,
        tenderedMinor: '2000',
      });
      expect(replay.status).toBe(201);
      expect(replay.body.intent.id).toBe(res.body.intent.id);
      expect(replay.body).toMatchObject({
        dueMinor: '1885',
        changeMinor: '115',
        roundingMinor: '2',
      });
      expect((await readOrder(db.admin, o.orderId)).rounding_minor).toBe(2n);
      expect(await outbox('payment.captured', res.body.intent.id)).toBe(1);
    });

    it('rounds down as well: 1881 is taken as 1880 and the order total follows', async () => {
      const o = await order(1881);
      const res = await post('/v1/payments/cash-tenders', {
        locationId: o.locationId,
        orderId: o.orderId,
        checkId: o.checkId,
        clientIntentId: key(),
      });
      expect(res.body).toMatchObject({ dueMinor: '1880', changeMinor: '0', roundingMinor: '-1' });
      expect(await readOrder(db.admin, o.orderId)).toMatchObject({
        total_minor: 1880n,
        paid_minor: 1880n,
        rounding_minor: -1n,
        payment_status: 'paid',
      });
    });

    it('a partial cash payment is exact; the final cash tender carries the rounding', async () => {
      const o = await order(2003);
      const first = await post('/v1/payments/cash-tenders', {
        locationId: o.locationId,
        orderId: o.orderId,
        checkId: o.checkId,
        clientIntentId: key(),
        amountMinor: '1000',
      });
      expect(first.body).toMatchObject({ dueMinor: '1000', roundingMinor: '0' });
      expect((await readOrder(db.admin, o.orderId)).payment_status).toBe('partially_paid');
      const final = await post('/v1/payments/cash-tenders', {
        locationId: o.locationId,
        orderId: o.orderId,
        checkId: o.checkId,
        clientIntentId: key(),
        tenderedMinor: '1005',
      });
      expect(final.body).toMatchObject({ dueMinor: '1005', roundingMinor: '2', changeMinor: '0' });
      expect(await readOrder(db.admin, o.orderId)).toMatchObject({
        payment_status: 'paid',
        total_minor: 2005n,
        paid_minor: 2005n,
      });
    });

    it('refuses overpaying, tendering less than due, and a voided order', async () => {
      const o = await order(1000);
      const base = { locationId: o.locationId, orderId: o.orderId, checkId: o.checkId };
      expect(
        (
          await post('/v1/payments/cash-tenders', {
            ...base,
            clientIntentId: key(),
            amountMinor: '1001',
          })
        ).body.error.code,
      ).toBe('AMOUNT_EXCEEDS_OUTSTANDING');
      expect(
        (
          await post('/v1/payments/cash-tenders', {
            ...base,
            clientIntentId: key(),
            tenderedMinor: '999',
          })
        ).body.error.code,
      ).toBe('TENDERED_BELOW_DUE');
      await db.admin.query(
        "UPDATE orders.orders SET status = 'voided', voided_at = now() WHERE id = $1",
        [o.orderId],
      );
      expect(
        (await post('/v1/payments/cash-tenders', { ...base, clientIntentId: key() })).body.error
          .code,
      ).toBe('ORDER_NOT_PAYABLE');
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('card payments and the "paid only when captured" invariant', () => {
    it('auto-capture: created → processing → captured, masked card details only, outbox event once', async () => {
      const o = await order(2500);
      const intent = await newIntent(o, 2500);
      expect(intent.status).toBe('created');
      expect((await readOrder(db.admin, o.orderId)).payment_status).toBe('unpaid');

      const res = await submit(intent.id);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'captured',
        capturedMinor: '2500',
        settlementStatus: 'unsettled',
        card: {
          cardBrand: 'visa',
          last4: '4242',
          entryMode: 'contactless',
          applicationLabel: 'VISA CREDIT',
        },
      });
      expect(res.body.providerReference).toMatch(/^mock_/);
      expect(res.body.card.authCode).toMatch(/^A\d+/);
      expect(await readOrder(db.admin, o.orderId)).toMatchObject({
        payment_status: 'paid',
        paid_minor: 2500n,
      });
      expect(
        (await events(intent.id)).map((e) => [e.kind, e.from_status, e.to_status, e.source]),
      ).toEqual([
        ['created', null, 'created', 'admin'], // a web (admin console) token; a POS token records source 'pos'
        ['submitted', 'created', 'processing', 'admin'],
        ['captured', 'processing', 'captured', 'admin'],
      ]);
      expect(await outbox('payment.captured', intent.id)).toBe(1);

      const attempts = (await get(`/v1/payments/intents/${intent.id}/attempts`)).body;
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        operation: 'sale',
        status: 'succeeded',
        providerIdempotencyKey: `${intent.id}:sale`,
      });
      const list = (await get(`/v1/payments/intents?orderId=${o.orderId}`)).body;
      expect(list.items.map((i: { id: string }) => i.id)).toEqual([intent.id]);
    });

    it('authorised money is not "paid": the order stays unpaid until capture', async () => {
      const o = await order(4000);
      const intent = await newIntent(o, 4000, { providerAccountId: manualAccountId });
      const authorised = await submit(intent.id);
      expect(authorised.body).toMatchObject({
        status: 'authorized',
        authorizedMinor: '4000',
        capturedMinor: '0',
      });
      expect(await readOrder(db.admin, o.orderId)).toMatchObject({
        payment_status: 'unpaid',
        paid_minor: 0n,
      });
      expect(await outbox('payment.authorized', intent.id)).toBe(1);

      const captured = await post(`/v1/payments/intents/${intent.id}/capture`, { tipMinor: '0' });
      expect(captured.status, JSON.stringify(captured.body)).toBe(200);
      expect(captured.body).toMatchObject({ status: 'captured', capturedMinor: '4000' });
      expect(await readOrder(db.admin, o.orderId)).toMatchObject({
        payment_status: 'paid',
        paid_minor: 4000n,
      });
    });

    it('a request sent to the provider is not money collected: while processing the order is unpaid', async () => {
      const o = await order(1200);
      const intent = await newIntent(o, 1200);
      let seen: { order: string; intent: string } | null = null;
      t.faults.afterProviderCall = async () => {
        // the provider has already approved at this point; we have not recorded it
        seen = {
          order: (await readOrder(db.admin, o.orderId)).payment_status,
          intent: (await intentRow(intent.id)).status,
        };
      };
      await submit(intent.id).expect(200);
      expect(seen).toEqual({ order: 'unpaid', intent: 'processing' });
    });

    it('split tender: a card part and a cash part together settle the check', async () => {
      const o = await order(3000);
      const cardIntent = await newIntent(o, 1000);
      await submit(cardIntent.id).expect(200);
      expect((await readOrder(db.admin, o.orderId)).payment_status).toBe('partially_paid');
      const tooMuch = await post('/v1/payments/intents', {
        locationId: o.locationId,
        orderId: o.orderId,
        checkId: o.checkId,
        clientIntentId: key(),
        method: 'card_not_present',
        amountMinor: '2001',
        providerAccountId: accountId,
      });
      expect(tooMuch.body.error.code).toBe('AMOUNT_EXCEEDS_OUTSTANDING');
      const cash = await post('/v1/payments/cash-tenders', {
        locationId: o.locationId,
        orderId: o.orderId,
        checkId: o.checkId,
        clientIntentId: key(),
      });
      expect(cash.body.dueMinor).toBe('2000');
      expect(await readOrder(db.admin, o.orderId)).toMatchObject({
        payment_status: 'paid',
        paid_minor: 3000n,
      });
    });

    it('a decline fails the intent with a certain answer; a new intent with a new key succeeds', async () => {
      const o = await order(1500);
      t.provider.script('createPayment', 'decline');
      const first = await newIntent(o, 1500);
      const declined = await submit(first.id);
      expect(declined.body).toMatchObject({
        status: 'failed',
        lastError: { code: 'do_not_honour' },
        capturedMinor: '0',
      });
      expect((await readOrder(db.admin, o.orderId)).payment_status).toBe('unpaid');
      expect(await outbox('payment.failed', first.id)).toBe(1);
      expect((await intentRowAttempts(first.id))[0]).toMatchObject({
        status: 'declined',
        error_code: 'do_not_honour',
      });
      // re-submitting a failed intent never reaches the provider again
      const before = t.provider.callLog.length;
      await submit(first.id).expect(200);
      expect(t.provider.callLog.length).toBe(before);

      const retry = await newIntent(o, 1500);
      expect((await submit(retry.id)).body.status).toBe('captured');
      expect(await readOrder(db.admin, o.orderId)).toMatchObject({ payment_status: 'paid' });
    });

    it('card-present through a paired terminal records the terminal receipt block', async () => {
      const o = await order(900);
      const intent = await newIntent(o, 900, { method: 'card_present', terminalId });
      const res = await submit(intent.id);
      expect(res.body).toMatchObject({ status: 'captured', terminalId, offline: false });
      expect(res.body.card.terminalReceiptText).toContain('APPROVED 900 AUD');
      expect((await events(intent.id)).at(-1)!.source).toBe('terminal');
    });

    it('refuses an unsupported tender, a stranger’s check, and reusing a key for a different payment', async () => {
      const o = await order(1000);
      const body = {
        locationId: o.locationId,
        orderId: o.orderId,
        checkId: o.checkId,
        clientIntentId: key(),
        amountMinor: '100',
        providerAccountId: accountId,
      };
      expect(
        (await post('/v1/payments/intents', { ...body, method: 'gift_card' })).body.error.code,
      ).toBe('METHOD_NOT_SUPPORTED');
      const other = await order(1000, h.otherLocationId);
      expect(
        (
          await post('/v1/payments/intents', {
            ...body,
            method: 'card_not_present',
            checkId: other.checkId,
          })
        ).status,
      ).toBe(404);
      const first = await post('/v1/payments/intents', { ...body, method: 'card_not_present' });
      const same = await post('/v1/payments/intents', { ...body, method: 'card_not_present' });
      expect(same.body.id).toBe(first.body.id);
      const different = await post('/v1/payments/intents', {
        ...body,
        method: 'card_not_present',
        amountMinor: '101',
      });
      expect(different.status).toBe(422);
    });
  });

  async function intentRowAttempts(id: string) {
    const { rows } = await db.admin.query(
      'SELECT * FROM payments.payment_attempts WHERE intent_id = $1 ORDER BY attempt_no',
      [id],
    );
    return rows as {
      operation: string;
      status: string;
      error_code: string | null;
      request_redacted: unknown;
      response_redacted: unknown;
    }[];
  }

  // ---------------------------------------------------------------------------------------------

  describe('uncertain: resolved through the provider before any retry', () => {
    it('an uncertain sale is confirmed by getStatus: no retry, no second charge, order paid only then', async () => {
      const o = await order(1800);
      t.provider.script('createPayment', 'uncertain_then_approved');
      const intent = await newIntent(o, 1800);
      const res = await submit(intent.id);
      expect(res.body).toMatchObject({ status: 'uncertain', capturedMinor: '0' });
      expect(res.body.providerReference).toMatch(/^mock_/);
      expect((await readOrder(db.admin, o.orderId)).payment_status).toBe('unpaid');
      const queriesBefore = t.provider.statusQueryCount;
      const chargesBefore = t.provider.chargeCount;

      const summary = await t.sweepers.sweep({ tenantIds: [h.tenantId] });
      expect(summary).toMatchObject({ uncertainResolved: 1, errors: 0 });
      expect(t.provider.statusQueryCount).toBe(queriesBefore + 1);
      expect(t.provider.chargeCount).toBe(chargesBefore); // resolved by asking, not by retrying
      expect(await intentRow(intent.id)).toMatchObject({
        status: 'captured',
        captured_minor: 1800n,
      });
      expect(await readOrder(db.admin, o.orderId)).toMatchObject({
        payment_status: 'paid',
        paid_minor: 1800n,
      });
      const attempts = await intentRowAttempts(intent.id);
      expect(attempts.map((a) => [a.operation, a.status])).toEqual([
        ['sale', 'timeout'],
        ['status_query', 'succeeded'],
      ]);
      expect((await events(intent.id)).map((e) => e.kind)).toEqual([
        'created',
        'submitted',
        'timeout',
        'status_confirmed',
      ]);
      expect(await outbox('payment.captured', intent.id)).toBe(1);
    });

    it('an uncertain sale the provider actually declined becomes failed, never captured', async () => {
      const o = await order(1850);
      t.provider.script('createPayment', 'uncertain_then_declined');
      const intent = await newIntent(o, 1850);
      expect((await submit(intent.id)).body.status).toBe('uncertain');
      await t.sweepers.sweep({ tenantIds: [h.tenantId] });
      expect(await intentRow(intent.id)).toMatchObject({ status: 'failed', captured_minor: 0n });
      expect((await readOrder(db.admin, o.orderId)).payment_status).toBe('unpaid');
    });

    it('resolves within 60 s in the mock: sweeps every 10 s of virtual time, the provider unknown for the first two', async () => {
      const o = await order(1700);
      t.provider.script('createPayment', 'uncertain_then_approved');
      const intent = await newIntent(o, 1700);
      expect((await submit(intent.id)).body.status).toBe('uncertain');
      const unknownFor = { remaining: 2 };
      const realStatus = t.provider.getStatus.bind(t.provider);
      t.provider.getStatus = async (ref) =>
        unknownFor.remaining-- > 0 ? { state: 'unknown' } : realStatus(ref);
      try {
        const start = (await intentRow(intent.id)).updated_at as Date;
        const intervalMs = 10_000;
        let resolvedAfterMs: number | null = null;
        for (let tick = 1; tick <= 6; tick++) {
          await t.sweepers.sweep({
            tenantIds: [h.tenantId],
            now: new Date(start.getTime() + tick * intervalMs),
          });
          if ((await intentRow(intent.id)).status !== 'uncertain') {
            resolvedAfterMs = tick * intervalMs;
            break;
          }
        }
        expect(resolvedAfterMs).not.toBeNull();
        expect(resolvedAfterMs!).toBeLessThanOrEqual(60_000);
        expect(resolvedAfterMs).toBe(30_000); // two unknown answers, then the confirmation
        expect(await intentRow(intent.id)).toMatchObject({ status: 'captured' });
        const { rows } = await db.admin.query(
          'SELECT COUNT(*)::int AS n FROM payments.reconciliation_exceptions WHERE subject_id = $1',
          [intent.id],
        );
        expect(rows[0].n).toBe(0);
      } finally {
        t.provider.getStatus = realStatus;
      }
    });

    it('an intent still unknown after the escalation window raises uncertain_aged once, and stays uncertain', async () => {
      const o = await order(1710);
      t.provider.script('createPayment', 'uncertain_then_approved');
      const intent = await newIntent(o, 1710);
      await submit(intent.id).expect(200);
      const realStatus = t.provider.getStatus.bind(t.provider);
      t.provider.getStatus = async () => ({ state: 'unknown' });
      try {
        const later = new Date(Date.now() + 16 * 60_000);
        const first = await t.sweepers.sweep({ tenantIds: [h.tenantId], now: later });
        const second = await t.sweepers.sweep({ tenantIds: [h.tenantId], now: later });
        expect(first.escalated).toBe(1);
        expect(second.escalated).toBe(0); // dedupe
        expect((await intentRow(intent.id)).status).toBe('uncertain');
        const list = await get(
          '/v1/payments/reconciliation-exceptions?kind=uncertain_aged&status=open',
        );
        expect(
          list.body.items.filter((e: { subjectId: string }) => e.subjectId === intent.id),
        ).toHaveLength(1);
      } finally {
        t.provider.getStatus = realStatus;
      }
      await t.sweepers.sweep({ tenantIds: [h.tenantId] }); // provider answers again: resolves
      expect((await intentRow(intent.id)).status).toBe('captured');
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('invariant: no acknowledged payment is lost across a simulated crash', () => {
    it('crash after the provider approved, before the result was recorded: the sweeper completes it with one charge', async () => {
      const o = await order(2600);
      const intent = await newIntent(o, 2600);
      const chargesBefore = t.provider.chargeCount;
      t.faults.afterProviderCall = () => {
        throw new Error('simulated crash after the provider acknowledged');
      };
      const crashed = await submit(intent.id);
      expect(crashed.status).toBe(500);
      t.faults.afterProviderCall = undefined;

      // provider holds the money, the platform has no record yet
      expect(t.provider.chargeCount).toBe(chargesBefore + 1);
      expect(await intentRow(intent.id)).toMatchObject({
        status: 'processing',
        captured_minor: 0n,
        provider_reference: null,
      });
      expect((await intentRowAttempts(intent.id)).map((a) => a.status)).toEqual(['started']);
      expect((await readOrder(db.admin, o.orderId)).payment_status).toBe('unpaid');

      // too early: the sweeper leaves a fresh processing row alone
      const early = await t.sweepers.sweep({ tenantIds: [h.tenantId] });
      expect(early.stuckMovedToUncertain).toBe(0);
      expect((await intentRow(intent.id)).status).toBe('processing');

      const swept = await t.sweepers.sweep({
        tenantIds: [h.tenantId],
        now: new Date(Date.now() + 31_000),
      });
      expect(swept).toMatchObject({ stuckMovedToUncertain: 1, uncertainResolved: 1, errors: 0 });
      expect(await intentRow(intent.id)).toMatchObject({
        status: 'captured',
        captured_minor: 2600n,
      });
      expect(t.provider.chargeCount).toBe(chargesBefore + 1); // recovered, not recharged
      expect(await readOrder(db.admin, o.orderId)).toMatchObject({
        payment_status: 'paid',
        paid_minor: 2600n,
      });
      expect(await outbox('payment.captured', intent.id)).toBe(1);
      expect((await events(intent.id)).map((e) => e.kind)).toEqual([
        'created',
        'submitted',
        'timeout',
        'status_confirmed',
      ]);
      // a second sweep finds nothing to do
      expect(
        await t.sweepers.sweep({ tenantIds: [h.tenantId], now: new Date(Date.now() + 120_000) }),
      ).toMatchObject({ stuckMovedToUncertain: 0, uncertainResolved: 0 });
    });

    it('timeout after the provider recorded the charge (we never saw a reference): replay under the same key finds it', async () => {
      const o = await order(2700);
      t.provider.script('createPayment', 'timeout_after_submit');
      const chargesBefore = t.provider.chargeCount;
      const intent = await newIntent(o, 2700);
      const res = await submit(intent.id);
      expect(res.body).toMatchObject({ status: 'uncertain', providerReference: null });
      expect(t.provider.chargeCount).toBe(chargesBefore + 1);
      await t.sweepers.sweep({ tenantIds: [h.tenantId] });
      expect(await intentRow(intent.id)).toMatchObject({
        status: 'captured',
        captured_minor: 2700n,
      });
      expect(t.provider.chargeCount).toBe(chargesBefore + 1);
      expect((await readOrder(db.admin, o.orderId)).payment_status).toBe('paid');
    });

    it('a timeout before the provider saw anything is retried with the same key and charges exactly once', async () => {
      const o = await order(2800);
      t.provider.script('createPayment', 'timeout');
      const chargesBefore = t.provider.chargeCount;
      const intent = await newIntent(o, 2800);
      expect((await submit(intent.id)).body.status).toBe('uncertain');
      expect(t.provider.chargeCount).toBe(chargesBefore);
      await t.sweepers.sweep({ tenantIds: [h.tenantId] });
      expect(await intentRow(intent.id)).toMatchObject({ status: 'captured' });
      expect(t.provider.chargeCount).toBe(chargesBefore + 1);
      const keys = t.provider.callLog.filter(
        (c) => c.operation === 'createPayment' && c.idem === `${intent.id}:sale`,
      );
      expect(keys.length).toBe(2); // the original call and the replay carry the same idempotency key
    });
  });

  describe('invariant: an internal retry never charges twice', () => {
    it('five concurrent submits and a later re-submit reach the provider once', async () => {
      const o = await order(3300);
      const intent = await newIntent(o, 3300);
      const chargesBefore = t.provider.chargeCount;
      const callsBefore = t.provider.callLog.filter((c) => c.operation === 'createPayment').length;
      const results = await Promise.all(Array.from({ length: 5 }, () => submit(intent.id)));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(t.provider.chargeCount).toBe(chargesBefore + 1);
      expect(t.provider.callLog.filter((c) => c.operation === 'createPayment').length).toBe(
        callsBefore + 1,
      );
      const again = await submit(intent.id);
      expect(again.body.status).toBe('captured');
      expect(t.provider.chargeCount).toBe(chargesBefore + 1);
      expect(await outbox('payment.captured', intent.id)).toBe(1);
    });

    it('concurrent creates with the same client key produce one intent', async () => {
      const o = await order(500);
      const clientIntentId = key();
      const body = {
        locationId: o.locationId,
        orderId: o.orderId,
        checkId: o.checkId,
        clientIntentId,
        method: 'card_not_present',
        amountMinor: '500',
        providerAccountId: accountId,
      };
      const results = await Promise.all(
        Array.from({ length: 6 }, () => post('/v1/payments/intents', body)),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      const { rows } = await db.admin.query(
        'SELECT COUNT(*)::int AS n FROM payments.payment_intents WHERE check_id = $1',
        [o.checkId],
      );
      expect(rows[0].n).toBe(1);
    });

    it('concurrent cash tenders with the same key take the money once', async () => {
      const o = await order(1000);
      const body = {
        locationId: o.locationId,
        orderId: o.orderId,
        checkId: o.checkId,
        clientIntentId: key(),
      };
      const results = await Promise.all(
        Array.from({ length: 5 }, () => post('/v1/payments/cash-tenders', body)),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(new Set(results.map((r) => r.body.intent.id)).size).toBe(1);
      expect(await readOrder(db.admin, o.orderId)).toMatchObject({
        paid_minor: 1000n,
        payment_status: 'paid',
      });
    });

    it('a submit and the sweeper racing on the same intent still produce a single charge and a single outbox event', async () => {
      const o = await order(3400);
      const intent = await newIntent(o, 3400);
      const chargesBefore = t.provider.chargeCount;
      t.faults.afterProviderCall = async () => {
        // while the submit is between provider call and settle, the sweeper runs with a far-future clock
        await t.sweepers.sweep({ tenantIds: [h.tenantId], now: new Date(Date.now() + 60_000) });
      };
      const res = await submit(intent.id);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('captured');
      expect(t.provider.chargeCount).toBe(chargesBefore + 1);
      expect(await outbox('payment.captured', intent.id)).toBe(1);
      expect(await readOrder(db.admin, o.orderId)).toMatchObject({ paid_minor: 3400n });
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('refunds', () => {
    async function returnOrder(): Promise<OrderFixture> {
      return createOrderFixture(db.admin, h.tenantId, h.locationId, 0, { kind: 'return' });
    }

    it('partial then full: partially_refunded → refunded, order totals follow, over-refund and replays are safe', async () => {
      const { o, intent } = await capturedPayment(2000);
      const ret = await returnOrder();
      const clientRefundId = `rf-${randomUUID()}`;
      const first = await post(`/v1/payments/intents/${intent.id}/refunds`, {
        orderId: ret.orderId,
        clientRefundId,
        amountMinor: '500',
        reason: 'damaged',
      });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body).toMatchObject({
        status: 'succeeded',
        amountMinor: '500',
        method: 'original',
        reason: 'damaged',
      });
      expect(await intentRow(intent.id)).toMatchObject({
        status: 'partially_refunded',
        refunded_minor: 500n,
      });
      expect(await readOrder(db.admin, o.orderId)).toMatchObject({
        payment_status: 'partially_refunded',
        refunded_minor: 500n,
      });

      const refundCalls = () => t.provider.callLog.filter((c) => c.operation === 'refund').length;
      const callsBefore = refundCalls();
      const replay = await post(`/v1/payments/intents/${intent.id}/refunds`, {
        orderId: ret.orderId,
        clientRefundId,
        amountMinor: '500',
      });
      expect(replay.body.id).toBe(first.body.id);
      expect(refundCalls()).toBe(callsBefore);
      const mismatch = await post(`/v1/payments/intents/${intent.id}/refunds`, {
        orderId: ret.orderId,
        clientRefundId,
        amountMinor: '501',
      });
      expect(mismatch.status).toBe(422);

      const over = await post(`/v1/payments/intents/${intent.id}/refunds`, {
        orderId: ret.orderId,
        clientRefundId: `rf-${randomUUID()}`,
        amountMinor: '1501',
      });
      expect(over.body.error.code).toBe('REFUND_EXCEEDS_CAPTURED');
      const rest = await post(`/v1/payments/intents/${intent.id}/refunds`, {
        orderId: ret.orderId,
        clientRefundId: `rf-${randomUUID()}`,
        amountMinor: '1500',
      });
      expect(rest.body.status).toBe('succeeded');
      expect(await intentRow(intent.id)).toMatchObject({
        status: 'refunded',
        refunded_minor: 2000n,
      });
      expect(await readOrder(db.admin, o.orderId)).toMatchObject({ payment_status: 'refunded' });
      expect(await outbox('refund.succeeded', intent.id)).toBe(2);
      expect((await get(`/v1/payments/intents/${intent.id}/refunds`)).body).toHaveLength(2);
      expect((await events(intent.id)).filter((e) => e.kind === 'refunded')).toHaveLength(2);

      const afterFull = await post(`/v1/payments/intents/${intent.id}/refunds`, {
        orderId: ret.orderId,
        clientRefundId: `rf-${randomUUID()}`,
        amountMinor: '1',
      });
      expect(afterFull.body.error.code).toBe('INVALID_STATE');
    });

    it('a refund that ends uncertain is resolved by replaying the same key: refunded exactly once', async () => {
      const { intent, ref } = await capturedPayment(1000);
      const ret = await returnOrder();
      t.provider.script('refund', 'timeout_after_submit');
      const res = await post(`/v1/payments/intents/${intent.id}/refunds`, {
        orderId: ret.orderId,
        clientRefundId: `rf-${randomUUID()}`,
        amountMinor: '400',
      });
      expect(res.body.status).toBe('uncertain');
      expect((await intentRow(intent.id)).status).toBe('captured'); // not refunded until the provider confirms
      expect(t.provider.ledger({ provider: 'mock', providerPaymentId: ref })!.refunded).toBe(400n);
      const swept = await t.sweepers.sweep({ tenantIds: [h.tenantId] });
      expect(swept.refundsResolved).toBe(1);
      expect(await intentRow(intent.id)).toMatchObject({
        status: 'partially_refunded',
        refunded_minor: 400n,
      });
      expect(t.provider.ledger({ provider: 'mock', providerPaymentId: ref })!.refunded).toBe(400n);
    });

    it('a crash between the provider refund and recording it is recovered without refunding twice', async () => {
      const { intent, ref } = await capturedPayment(1100);
      const ret = await returnOrder();
      t.refundFaults.afterProviderCall = () => {
        throw new Error('simulated crash');
      };
      const crashed = await post(`/v1/payments/intents/${intent.id}/refunds`, {
        orderId: ret.orderId,
        clientRefundId: `rf-${randomUUID()}`,
        amountMinor: '300',
      });
      expect(crashed.status).toBe(500);
      t.refundFaults.afterProviderCall = undefined;
      const { rows } = await db.admin.query(
        'SELECT status FROM payments.refunds WHERE intent_id = $1',
        [intent.id],
      );
      expect(rows[0].status).toBe('processing');
      await t.sweepers.sweep({ tenantIds: [h.tenantId], now: new Date(Date.now() + 31_000) });
      expect(await intentRow(intent.id)).toMatchObject({
        status: 'partially_refunded',
        refunded_minor: 300n,
      });
      expect(t.provider.ledger({ provider: 'mock', providerPaymentId: ref })!.refunded).toBe(300n);
    });

    it('a cash payment is refunded in cash without calling a provider', async () => {
      const o = await order(1000);
      const cash = await post('/v1/payments/cash-tenders', {
        locationId: o.locationId,
        orderId: o.orderId,
        checkId: o.checkId,
        clientIntentId: key(),
      });
      const ret = await returnOrder();
      const calls = t.provider.callLog.length;
      const res = await post(`/v1/payments/intents/${cash.body.intent.id}/refunds`, {
        orderId: ret.orderId,
        clientRefundId: `rf-${randomUUID()}`,
        amountMinor: '1000',
      });
      expect(res.body).toMatchObject({ status: 'succeeded', method: 'cash' });
      expect(t.provider.callLog.length).toBe(calls);
      expect(await intentRow(cash.body.intent.id)).toMatchObject({ status: 'refunded' });
    });

    it('refund limits and scopes: a limited cashier is stopped, an out-of-scope manager gets 404', async () => {
      const { intent } = await capturedPayment(900);
      const ret = await returnOrder();
      const limited = t.auth.register('limited', {
        ...paymentsPrincipal(h.tenantId, { kind: 'location', id: h.locationId }),
        assignments: [
          {
            assignmentId: randomUUID(),
            role: 'cashier',
            permissions: ['orders.refund.create', 'payments.view'],
            scope: { kind: 'location', id: h.locationId },
            coveredScopeIds: [],
            limits: { 'orders.refund.max_minor': 100 },
          },
        ],
      });
      const body = {
        orderId: ret.orderId,
        clientRefundId: `rf-${randomUUID()}`,
        amountMinor: '500',
      };
      const limitRes = await post(`/v1/payments/intents/${intent.id}/refunds`, body, limited);
      expect(limitRes.status).toBe(409);
      expect(limitRes.body.error.code).toBe('LIMIT_EXCEEDED');
      expect(
        (
          await post(
            `/v1/payments/intents/${intent.id}/refunds`,
            { ...body, amountMinor: '100' },
            limited,
          )
        ).status,
      ).toBe(201);
      expect(
        (await post(`/v1/payments/intents/${intent.id}/refunds`, body, otherLocationMgr)).status,
      ).toBe(404);
      const noPerm = t.auth.register(
        'viewer',
        paymentsPrincipal(h.tenantId, { kind: 'location', id: h.locationId }, ['payments.view']),
      );
      expect((await post(`/v1/payments/intents/${intent.id}/refunds`, body, noPerm)).status).toBe(
        403,
      );
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('void, cancel and release', () => {
    it('cancel before submit; release an authorisation; void a captured payment', async () => {
      const o1 = await order(700);
      const created = await newIntent(o1, 700);
      expect((await post(`/v1/payments/intents/${created.id}/cancel`)).body.status).toBe(
        'cancelled',
      );
      expect((await submit(created.id)).body.status).toBe('cancelled'); // never reaches a provider

      const o2 = await order(710);
      const auth = await newIntent(o2, 710, { providerAccountId: manualAccountId });
      await submit(auth.id).expect(200);
      expect((await post(`/v1/payments/intents/${auth.id}/cancel`)).body).toMatchObject({
        status: 'cancelled',
        authorizedMinor: '0',
      });
      expect((await post(`/v1/payments/intents/${auth.id}/capture`)).body.error.code).toBe(
        'INVALID_STATE',
      );

      const { o, intent } = await capturedPayment(720);
      const voided = await post(`/v1/payments/intents/${intent.id}/reverse`);
      expect(voided.body).toMatchObject({ status: 'reversed', capturedMinor: '0' });
      expect(await readOrder(db.admin, o.orderId)).toMatchObject({
        payment_status: 'unpaid',
        paid_minor: 0n,
      });
      expect((await post(`/v1/payments/intents/${intent.id}/reverse`)).body.error.code).toBe(
        'INVALID_STATE',
      );
    });

    it('a capture the provider refuses leaves the authorisation in place and records why', async () => {
      const o = await order(800);
      const auth = await newIntent(o, 800, { providerAccountId: manualAccountId });
      await submit(auth.id).expect(200);
      t.provider.script('capture', 'decline');
      const refused = await post(`/v1/payments/intents/${auth.id}/capture`, {});
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('CAPTURE_DECLINED');
      expect((await intentRow(auth.id)).status).toBe('authorized');
      expect((await events(auth.id)).map((e) => e.kind)).toContain('capture_declined'); // survived the error
      const ok = await post(`/v1/payments/intents/${auth.id}/capture`, {});
      expect(ok.body.status).toBe('captured');
    });

    it('a crash after the provider captured an authorisation is recovered by asking the provider', async () => {
      const o = await order(810);
      const auth = await newIntent(o, 810, { providerAccountId: manualAccountId });
      await submit(auth.id).expect(200);
      t.faults.afterProviderCall = () => {
        throw new Error('simulated crash after capture');
      };
      expect((await post(`/v1/payments/intents/${auth.id}/capture`, {})).status).toBe(500);
      t.faults.afterProviderCall = undefined;
      expect((await intentRow(auth.id)).status).toBe('authorized');
      const swept = await t.sweepers.sweep({
        tenantIds: [h.tenantId],
        now: new Date(Date.now() + 31_000),
      });
      expect(swept.operationsRecovered).toBe(1);
      expect(await intentRow(auth.id)).toMatchObject({ status: 'captured', captured_minor: 810n });
      expect((await readOrder(db.admin, o.orderId)).payment_status).toBe('paid');
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('data integrity', () => {
    it('payment_events is append-only: no update, no delete, whoever asks', async () => {
      const { intent } = await capturedPayment(300);
      await expect(
        db.admin.query('UPDATE payments.payment_events SET kind = $1 WHERE intent_id = $2', [
          'tampered',
          intent.id,
        ]),
      ).rejects.toThrow();
      await expect(
        db.admin.query('DELETE FROM payments.payment_events WHERE intent_id = $1', [intent.id]),
      ).rejects.toThrow();
      expect((await events(intent.id)).map((e) => e.kind)).toEqual([
        'created',
        'submitted',
        'captured',
      ]);
    });

    it('stored attempts and events never hold a PAN, CVV or track data: payloads are redacted on the way in', async () => {
      const { intent } = await capturedPayment(310);
      const runner = t.app.get(PaymentsRunner);
      const ledger = t.app.get(PaymentsLedger);
      await runner.system(h.tenantId, async (uow) => {
        await ledger.startAttempt(uow.db, intent.id, {
          operation: 'status_query',
          providerIdempotencyKey: 'redaction-probe',
          request: {
            pan: '4242424242424242',
            cvv: '123',
            track2: ';4242424242424242=2512',
            note: 'paid with 4242 4242 4242 4242',
            amountMinor: '1',
          },
        });
        await ledger.insertEvent(
          uow.db,
          intent.id,
          { source: 'system' },
          {
            kind: 'probe',
            payload: { cardNumber: '4242424242424242', expiry: '12/30', last4: '4242' },
          },
        );
      });
      const attempt = (await intentRowAttempts(intent.id)).find(
        (a) => a.operation === 'status_query',
      )!;
      const stored = JSON.stringify(attempt.request_redacted);
      expect(stored).not.toMatch(/4242 ?4242 ?4242 ?4242/);
      expect(stored).not.toContain('"123"');
      expect(stored).not.toContain('2512');
      expect(stored).toContain('[redacted]');
      expect(stored).toContain('************4242');
      const probe = (await events(intent.id)).find((e) => e.kind === 'probe')!;
      expect(JSON.stringify(probe.payload)).not.toMatch(/4242424242424242|12\/30/);
      expect(probe.payload).toMatchObject({ last4: '4242' });
      // and nothing in the intent's full dump looks like a card number
      const dump = await db.admin.query(
        `SELECT (SELECT string_agg(row_to_json(a)::text, '') FROM payments.payment_attempts a WHERE intent_id = $1) ||
                (SELECT string_agg(row_to_json(e)::text, '') FROM payments.payment_events e WHERE intent_id = $1) ||
                (SELECT row_to_json(c)::text FROM payments.card_payment_details c WHERE intent_id = $1) AS dump`,
        [intent.id],
      );
      expect(dump.rows[0].dump).not.toMatch(/\b4\d{15}\b/);
    });

    it('database constraints back the invariants: captured ≤ amount + tip + surcharge, refunded ≤ captured, forward only when offline', async () => {
      const { intent } = await capturedPayment(320);
      await expect(
        db.admin.query(
          'UPDATE payments.payment_intents SET captured_minor = 999999 WHERE id = $1',
          [intent.id],
        ),
      ).rejects.toThrow(/check/i);
      await expect(
        db.admin.query('UPDATE payments.payment_intents SET refunded_minor = 321 WHERE id = $1', [
          intent.id,
        ]),
      ).rejects.toThrow(/check/i);
      await expect(
        db.admin.query(
          "UPDATE payments.payment_intents SET forward_outcome = 'pending' WHERE id = $1",
          [intent.id],
        ),
      ).rejects.toThrow(/check/i);
    });

    it('the Drizzle mirror of every payments table matches the migrated database', async () => {
      const mirror = Object.fromEntries(
        Object.entries(schema).filter(([name]) =>
          [
            'paymentProviderAccounts',
            'paymentTerminals',
            'paymentIntents',
            'paymentAttempts',
            'paymentEvents',
            'refunds',
            'cardPaymentDetails',
            'webhookInbox',
            'settlements',
            'settlementLines',
            'reconciliationExceptions',
            'disputes',
          ].includes(name),
        ),
      );
      expect(Object.keys(mirror)).toHaveLength(12);
      expect(await checkSchemaMirror(db.admin, mirror)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('tenant and scope isolation', () => {
    it('a foreign tenant and an out-of-scope manager get 404 for every intent route, and lists never leak', async () => {
      const { intent } = await capturedPayment(330);
      const i = intent.id;
      for (const token of [ownerB, otherLocationMgr]) {
        expect((await get(`/v1/payments/intents/${i}`, token)).status).toBe(404);
        expect((await get(`/v1/payments/intents/${i}/events`, token)).status).toBe(404);
        expect((await get(`/v1/payments/intents/${i}/attempts`, token)).status).toBe(404);
        expect((await get(`/v1/payments/intents/${i}/refunds`, token)).status).toBe(404);
        expect((await post(`/v1/payments/intents/${i}/submit`, {}, token)).status).toBe(404);
        expect((await post(`/v1/payments/intents/${i}/capture`, {}, token)).status).toBe(404);
        expect((await post(`/v1/payments/intents/${i}/cancel`, {}, token)).status).toBe(404);
        expect((await post(`/v1/payments/intents/${i}/reverse`, {}, token)).status).toBe(404);
        expect(
          (await post(`/v1/payments/intents/${i}/forward-outcome`, { outcome: 'approved' }, token))
            .status,
        ).toBe(404);
        const list = await get('/v1/payments/intents', token);
        expect(JSON.stringify(list.body)).not.toContain(i);
      }
      expect((await get(`/v1/payments/provider-accounts/${accountId}`, ownerB)).status).toBe(404);
      expect((await get(`/v1/payments/terminals/${terminalId}`, ownerB)).status).toBe(404);
      expect((await get('/v1/payments/provider-accounts', ownerB)).body).toEqual([]);
      expect((await get(`/v1/payments/intents/${i}`, locationMgr)).status).toBe(200);
    });

    it('a foreign tenant cannot create a payment against tenant A’s check or terminal', async () => {
      const o = await order(500);
      const res = await post(
        '/v1/payments/intents',
        {
          locationId: hB.locationId,
          orderId: o.orderId,
          checkId: o.checkId,
          clientIntentId: key(),
          method: 'card_not_present',
          amountMinor: '500',
          providerAccountId: accountId,
        },
        ownerB,
      );
      expect(res.status).toBe(404);
      const cash = await post(
        '/v1/payments/cash-tenders',
        {
          locationId: hB.locationId,
          orderId: o.orderId,
          checkId: o.checkId,
          clientIntentId: key(),
        },
        ownerB,
      );
      expect(cash.status).toBe(404);
      const asA = await post(
        '/v1/payments/intents',
        {
          locationId: h.locationId,
          orderId: o.orderId,
          checkId: o.checkId,
          clientIntentId: key(),
          method: 'card_not_present',
          amountMinor: '500',
          providerAccountId: accountId,
        },
        ownerB,
      );
      expect(asA.status).toBe(404); // scope guard: location A is not tenant B's
    });

    it('webhook secrets are per account: the same payload signed for another tenant’s account is refused', async () => {
      const probe = new MockPaymentProvider({ webhookSecret: 'whsec_somebody_else' });
      const { intent } = await capturedPayment(340);
      const row = await intentRow(intent.id);
      const forged = probe.emitWebhook('payment.reversed', {
        provider: 'mock',
        providerPaymentId: row.provider_reference!,
      });
      const res = await api()
        .post(`/v1/payments/webhooks/mock/${h.tenantId}/${accountId}`)
        .set(forged.headers)
        .send(forged.rawBody);
      expect(res.status).toBe(401);
      expect((await intentRow(intent.id)).status).toBe('captured');
      void WEBHOOK_SECRET;
    });
  });
});
