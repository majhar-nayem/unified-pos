import { randomUUID } from 'node:crypto';

import { money } from '@pos/domain-core';
import { MockPaymentProvider, idempotencyKey } from '@pos/payments-sdk';
import {
  type FixtureRegistry,
  type HierarchyFixture,
  checkContractCompleteness,
  createHierarchyFixture,
  createIdentityFixture,
  formatHarnessReport,
  listOperations,
  runCrossTenantHarness,
  startPostgresWithSchema,
  type TestPostgres,
} from '@pos/testing';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type OrderFixture, createOrderFixture, readOrder } from './testing/fixtures.js';
import {
  type PaymentsTestApp,
  WEBHOOK_SECRET,
  createPaymentsTestApp,
  paymentsPrincipal,
} from './testing/payments-test-app.js';

/**
 * Webhook inbox (signature, replay, idempotency), the offline store-and-forward lifecycle with its
 * expiry sweeper, settlement import with reconciliation exceptions, and the cross-tenant harness.
 */
describe('payments edge: webhooks, offline, settlement', () => {
  let db: TestPostgres;
  let t: PaymentsTestApp;
  let h: HierarchyFixture;
  let hB: HierarchyFixture;
  let owner: string;
  let ownerB: string;
  let locationMgr: string;
  let accountId: string;
  let terminalId: string;
  let deviceId: string;
  let identityFixture: Awaited<ReturnType<typeof createIdentityFixture>>;
  const provider = new MockPaymentProvider({ webhookSecret: WEBHOOK_SECRET });

  const api = () => supertest(t.server);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const post = (url: string, body: unknown = {}, token = owner) =>
    api()
      .post(url)
      .set(auth(token))
      .send(body as object);
  const get = (url: string, token = owner) => api().get(url).set(auth(token));
  const key = () => `ci-${randomUUID()}`;
  const webhookUrl = (account = accountId, tenant = h.tenantId, p = 'mock') =>
    `/v1/payments/webhooks/${p}/${tenant}/${account}`;
  const deliver = (
    hook: { headers: Record<string, string>; rawBody: string },
    url = webhookUrl(),
  ) => api().post(url).set(hook.headers).send(hook.rawBody);

  const order = (total: number, locationId = h.locationId): Promise<OrderFixture> =>
    createOrderFixture(db.admin, h.tenantId, locationId, total);

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
    return res.body as { id: string };
  }
  const submit = (id: string, body: unknown = {}) =>
    post(`/v1/payments/intents/${id}/submit`, body);

  async function intentRow(id: string) {
    const { rows } = await db.admin.query('SELECT * FROM payments.payment_intents WHERE id = $1', [
      id,
    ]);
    return rows[0] as Record<string, unknown> & {
      status: string;
      captured_minor: bigint;
      offline: boolean;
      forward_outcome: string | null;
      settlement_status: string;
      settlement_pending: boolean;
      provider_reference: string | null;
      offline_expires_at: Date | null;
      forwarded_at: Date | null;
    };
  }
  // order by when it was recorded: occurred_at is when it happened (an offline approval predates its record)
  async function events(id: string) {
    const { rows } = await db.admin.query(
      'SELECT kind, source, payload FROM payments.payment_events WHERE intent_id = $1 ORDER BY recorded_at, id',
      [id],
    );
    return rows as { kind: string; source: string; payload: Record<string, unknown> }[];
  }
  async function outbox(type: string, aggregateId: string): Promise<number> {
    const { rows } = await db.admin.query(
      'SELECT COUNT(*)::int AS n FROM audit.outbox_events WHERE event_type = $1 AND aggregate_id = $2',
      [type, aggregateId],
    );
    return rows[0].n as number;
  }
  async function exceptions(subjectId: string) {
    const { rows } = await db.admin.query(
      'SELECT kind, severity, status, details FROM payments.reconciliation_exceptions WHERE subject_id = $1 ORDER BY created_at',
      [subjectId],
    );
    return rows as {
      kind: string;
      severity: string;
      status: string;
      details: Record<string, unknown>;
    }[];
  }
  async function inbox() {
    const { rows } = await db.admin.query(
      'SELECT * FROM payments.webhook_inbox WHERE tenant_id = $1 ORDER BY received_at, id',
      [h.tenantId],
    );
    return rows as {
      id: string;
      status: string;
      signature_valid: boolean;
      external_event_id: string;
      payload: Record<string, unknown>;
      attempts: number;
      error: string | null;
    }[];
  }

  /** An intent left `processing` by a crash after the provider approved: the platform has no reference yet. */
  async function crashedIntent(amount: number) {
    const o = await order(amount);
    const intent = await newIntent(o, amount);
    t.faults.afterProviderCall = () => {
      throw new Error('simulated crash');
    };
    expect((await submit(intent.id)).status).toBe(500);
    t.faults.afterProviderCall = undefined;
    return { o, intent, ref: provider.lastRef! };
  }

  /** An offline sale recorded against a (completed) order, as the sync of an offline device would. */
  async function offlineSale(
    amount: number,
    extra: Record<string, unknown> = {},
    orderStatus = 'completed',
  ) {
    const o = await order(amount);
    await db.admin.query(
      'UPDATE orders.orders SET status = $2, completed_at = now() WHERE id = $1',
      [o.orderId, orderStatus],
    );
    const res = await post('/v1/payments/offline-collections', {
      locationId: o.locationId,
      orderId: o.orderId,
      checkId: o.checkId,
      clientIntentId: key(),
      providerAccountId: accountId,
      terminalId,
      amountMinor: String(amount),
      collectedAt: new Date().toISOString(),
      card: {
        cardBrand: 'visa',
        last4: '4242',
        entryMode: 'contactless',
        authCode: 'OFF123',
        terminalReceiptText: 'OFFLINE APPROVED',
      },
      ...extra,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { o, intent: res.body as Record<string, unknown> & { id: string } };
  }

  beforeAll(async () => {
    db = await startPostgresWithSchema();
    t = await createPaymentsTestApp({ databaseUrl: db.appUrl, provider });
    h = await createHierarchyFixture(db.admin, 'edge-a');
    hB = await createHierarchyFixture(db.admin, 'edge-b');
    identityFixture = await createIdentityFixture(db.admin, h);
    deviceId = identityFixture.deviceId;
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
    const account = await post('/v1/payments/provider-accounts', {
      provider: 'mock',
      name: 'Mock',
      credentialsRef: 'mock/main',
      currencies: ['AUD'],
      settings: {
        captureMode: 'auto',
        offline: {
          enabled: true,
          windowHours: 24,
          maxTransactionMinor: '50000',
          maxCountPerDevice: 1,
        },
      },
    });
    accountId = account.body.id;
    const terminal = await post('/v1/payments/terminals', {
      locationId: h.locationId,
      providerAccountId: accountId,
      serialNumber: 'EDGE-1',
      connectionMode: 'lan',
    });
    terminalId = terminal.body.id;
    await post(`/v1/payments/terminals/${terminalId}/pair`, { code: '123456' }).expect(200);
  });

  afterAll(async () => {
    await t?.close();
    await db?.stop();
  });

  beforeEach(() => {
    t.faults.afterProviderCall = undefined;
    t.terminal.providerUnreachable = false;
  });

  // ---------------------------------------------------------------------------------------------

  describe('webhook inbox', () => {
    it('a signed webhook resolves a crashed intent; a replay is a no-op; processing is idempotent', async () => {
      const { o, intent, ref } = await crashedIntent(1250);
      expect((await intentRow(intent.id)).status).toBe('processing');
      const hook = provider.emitWebhook('payment.captured', ref);

      const first = await deliver(hook);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body).toMatchObject({ status: 'processed' });
      expect(await intentRow(intent.id)).toMatchObject({
        status: 'captured',
        captured_minor: 1250n,
        provider_reference: ref.providerPaymentId,
      });
      expect(await readOrder(db.admin, o.orderId)).toMatchObject({
        payment_status: 'paid',
        paid_minor: 1250n,
      });
      const log = await events(intent.id);
      expect(log.map((e) => [e.kind, e.source])).toEqual([
        ['created', 'admin'],
        ['submitted', 'admin'],
        ['webhook_received', 'provider_webhook'],
        ['captured', 'provider_webhook'],
      ]);
      expect(await outbox('payment.captured', intent.id)).toBe(1);

      // replay: same event id → duplicate, nothing changes anywhere
      const eventsBefore = (await events(intent.id)).length;
      const inboxBefore = (await inbox()).length;
      for (let i = 0; i < 3; i++) {
        const replay = await deliver(hook);
        expect(replay.status).toBe(200);
        expect(replay.body).toMatchObject({ status: 'duplicate', inboxId: null });
      }
      expect((await events(intent.id)).length).toBe(eventsBefore);
      expect((await inbox()).length).toBe(inboxBefore);
      expect(await outbox('payment.captured', intent.id)).toBe(1);
      expect((await readOrder(db.admin, o.orderId)).paid_minor).toBe(1250n);

      // a fresh event id for the same fact is processed but changes nothing (state already captured)
      const again = await deliver(provider.emitWebhook('payment.captured', ref));
      expect(again.body.status).toBe('processed');
      expect(await outbox('payment.captured', intent.id)).toBe(1);
      expect((await readOrder(db.admin, o.orderId)).paid_minor).toBe(1250n);

      // and the sweeper has nothing left to do for it
      expect(
        await t.sweepers.sweep({ tenantIds: [h.tenantId], now: new Date(Date.now() + 60_000) }),
      ).toMatchObject({ stuckMovedToUncertain: 0 });
    });

    it('concurrent deliveries of the same event process it once', async () => {
      const { intent, ref } = await crashedIntent(1260);
      const hook = provider.emitWebhook('payment.captured', ref);
      const results = await Promise.all(Array.from({ length: 6 }, () => deliver(hook)));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.filter((r) => r.body.status === 'processed')).toHaveLength(1);
      expect(results.filter((r) => r.body.status === 'duplicate')).toHaveLength(5);
      expect(await outbox('payment.captured', intent.id)).toBe(1);
    });

    it('a webhook resolves an uncertain intent without any status query', async () => {
      const o = await order(1270);
      provider.script('createPayment', 'uncertain_then_approved');
      const intent = await newIntent(o, 1270);
      expect((await submit(intent.id)).body.status).toBe('uncertain');
      const queries = provider.statusQueryCount;
      const res = await deliver(provider.emitWebhook('payment.captured', provider.lastRef!));
      expect(res.body.status).toBe('processed');
      expect((await intentRow(intent.id)).status).toBe('captured');
      expect(provider.statusQueryCount).toBe(queries);
      expect((await readOrder(db.admin, o.orderId)).payment_status).toBe('paid');
    });

    it('a forged signature is rejected, logged and recorded; it cannot burn a real event id or change anything', async () => {
      const { intent, ref } = await crashedIntent(1280);
      const attacker = new MockPaymentProvider({ webhookSecret: 'whsec_attacker' });
      // the attacker needs the platform's payment id and intent id (e.g. from a leaked receipt)
      const forged = attacker.emitWebhook('payment.captured', ref, {
        externalEventId: 'evt_burn_me',
      });
      const body = JSON.parse(forged.rawBody);
      body.data.object = {
        id: ref.providerPaymentId,
        amount: '1280',
        currency: 'AUD',
        status: 'captured',
        metadata: { tenantId: h.tenantId, intentId: intent.id },
      };
      const raw = JSON.stringify(body);
      const forgedHeaders = { ...forged.headers };

      const res = await api().post(webhookUrl()).set(forgedHeaders).send(raw);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_SIGNATURE');
      expect((await intentRow(intent.id)).status).toBe('processing'); // untouched
      const rejected = (await inbox()).filter((r) => r.status === 'invalid_signature').at(-1)!;
      expect(rejected).toMatchObject({ signature_valid: false });
      expect(rejected.external_event_id.startsWith('invalid:')).toBe(true); // never the claimed id
      expect(rejected.payload).toMatchObject({
        reason: 'mismatch',
        bodyBytes: Buffer.byteLength(raw),
      });
      expect(JSON.stringify(rejected.payload)).not.toContain(intent.id); // the unverified body is not stored
      const { rows: audit } = await db.admin.query(
        "SELECT COUNT(*)::int AS n FROM audit.audit_log WHERE action = 'payments.webhook.rejected' AND resource_id = $1",
        [rejected.id],
      );
      expect(audit[0].n).toBe(1);

      // the genuine event with the same id still goes through afterwards
      const genuine = provider.emitWebhook('payment.captured', ref, {
        externalEventId: 'evt_burn_me',
      });
      expect((await deliver(genuine)).body.status).toBe('processed');
      expect((await intentRow(intent.id)).status).toBe('captured');
    });

    it('rejects a tampered body, a missing signature, a stale timestamp and a malformed header', async () => {
      const { intent, ref } = await crashedIntent(1290);
      const hook = provider.emitWebhook('payment.captured', ref);
      const before = (await inbox()).filter((r) => r.status === 'invalid_signature').length;
      const tampered = await api()
        .post(webhookUrl())
        .set(hook.headers)
        .send(hook.rawBody.replace('1290', '1'));
      expect(tampered.status).toBe(401);
      expect(
        (await api().post(webhookUrl()).set('content-type', 'application/json').send(hook.rawBody))
          .status,
      ).toBe(401);
      const stale = provider.emitWebhook('payment.captured', ref, {
        at: new Date(Date.now() - 3_600_000),
      });
      expect((await deliver(stale)).status).toBe(401);
      expect(
        (
          await api()
            .post(webhookUrl())
            .set({ 'x-mock-signature': 'nonsense', 'content-type': 'application/json' })
            .send(hook.rawBody)
        ).status,
      ).toBe(401);
      const after = await inbox();
      expect(after.filter((r) => r.status === 'invalid_signature')).toHaveLength(before + 4);
      expect(
        after
          .filter((r) => r.status === 'invalid_signature')
          .slice(-4)
          .map((r) => (r.payload as { reason: string }).reason),
      ).toEqual(['mismatch', 'missing_header', 'stale_timestamp', 'malformed_header']);
      expect((await intentRow(intent.id)).status).toBe('processing');
    });

    it('unknown account, mismatched provider and foreign tenant are 404 and store nothing', async () => {
      const hook = provider.emitWebhook('payment.captured', {
        provider: 'mock',
        providerPaymentId: 'mock_none',
      });
      const before = (await db.admin.query('SELECT COUNT(*)::int AS n FROM payments.webhook_inbox'))
        .rows[0].n as number;
      expect((await deliver(hook, webhookUrl(randomUUID()))).status).toBe(404);
      expect((await deliver(hook, webhookUrl(accountId, h.tenantId, 'stripe'))).status).toBe(404);
      expect((await deliver(hook, webhookUrl(accountId, hB.tenantId))).status).toBe(404); // account is not tenant B's
      expect(
        (await db.admin.query('SELECT COUNT(*)::int AS n FROM payments.webhook_inbox')).rows[0].n,
      ).toBe(before);
    });

    it('an event for an unknown payment is ignored; a contradiction raises a critical exception instead of "fixing" state', async () => {
      const res = await deliver(
        provider.emitWebhook('payment.captured', {
          provider: 'mock',
          providerPaymentId: 'mock_does_not_exist',
        }),
      );
      expect(res.body.status).toBe('ignored');

      const o = await order(1300);
      const intent = await newIntent(o, 1300);
      await submit(intent.id).expect(200);
      const ref = provider.lastRef!;
      const contradiction = await deliver(provider.emitWebhook('payment.declined', ref));
      expect(contradiction.body.status).toBe('processed');
      expect((await intentRow(intent.id)).status).toBe('captured'); // untouched
      expect(await exceptions(intent.id)).toMatchObject([
        {
          kind: 'amount_mismatch',
          severity: 'critical',
          details: {
            source: 'webhook_contradiction',
            platformStatus: 'captured',
            providerEvent: 'payment.declined',
          },
        },
      ]);
    });

    it('a refund the platform did not record raises an exception; a dispute is recorded and marks the intent disputed', async () => {
      const o = await order(1400);
      const intent = await newIntent(o, 1400);
      await submit(intent.id).expect(200);
      const ref = provider.lastRef!;
      await provider.refund(ref, money(200, 'AUD'), idempotencyKey(`dashboard-${randomUUID()}`)); // refunded from the provider dashboard
      await deliver(provider.emitWebhook('refund.succeeded', ref)).expect(200);
      expect(await exceptions(intent.id)).toMatchObject([
        {
          kind: 'amount_mismatch',
          details: {
            source: 'webhook_refund',
            providerRefundedMinor: '200',
            platformRefundedMinor: '0',
          },
        },
      ]);

      await deliver(provider.emitWebhook('dispute.opened', ref)).expect(200);
      expect(await intentRow(intent.id)).toMatchObject({ settlement_status: 'disputed' });
      const { rows } = await db.admin.query(
        'SELECT status, amount_minor FROM payments.disputes WHERE intent_id = $1',
        [intent.id],
      );
      expect(rows).toEqual([{ status: 'opened', amount_minor: 1400n }]);
    });

    it('a delivery whose processing failed is kept and retried by the sweeper', async () => {
      const { intent, ref } = await crashedIntent(1500);
      const id = randomUUID();
      await db.admin.query(
        `INSERT INTO payments.webhook_inbox (id, tenant_id, provider, provider_account_id, external_event_id, event_type, signature_valid, status, attempts, error, payload)
         VALUES ($1, $2, 'mock', $3, $4, 'payment.captured', true, 'failed', 1, 'transient', $5)`,
        [
          id,
          h.tenantId,
          accountId,
          `evt_retry_${id}`,
          JSON.stringify({
            normalized: {
              type: 'payment.captured',
              rawType: 'payment.captured',
              occurredAt: new Date().toISOString(),
              refPaymentId: ref.providerPaymentId,
              amountMinor: '1500',
              currency: 'AUD',
              refundedMinor: null,
              metadata: { tenantId: h.tenantId, intentId: intent.id },
            },
            raw: {},
          }),
        ],
      );
      const swept = await t.sweepers.sweep({ tenantIds: [h.tenantId] });
      expect(swept.webhooksRetried).toBeGreaterThanOrEqual(1);
      expect((await inbox()).find((r) => r.id === id)).toMatchObject({
        status: 'processed',
        attempts: 2,
        error: null,
      });
      expect((await intentRow(intent.id)).status).toBe('captured');
    });

    it('the inbox listing needs the provider permission and shows status, never payloads', async () => {
      const res = await get('/v1/payments/webhook-inbox?status=invalid_signature');
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body.items[0]).not.toHaveProperty('payload');
      expect(
        res.body.items.every(
          (e: { status: string; signatureValid: boolean }) =>
            e.status === 'invalid_signature' && e.signatureValid === false,
        ),
      ).toBe(true);
      const noPerm = t.auth.register(
        'viewer',
        paymentsPrincipal(h.tenantId, { kind: 'tenant', id: h.tenantId }, ['payments.view']),
      );
      expect((await get('/v1/payments/webhook-inbox', noPerm)).status).toBe(403);
      expect((await get('/v1/payments/webhook-inbox', ownerB)).body.items).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('offline store-and-forward lifecycle (docs/01 §8.3)', () => {
    it('records an offline approval as captured with a pending forward and a window from the account settings', async () => {
      const collectedAt = new Date('2026-10-18T09:00:00.000Z');
      const { o, intent } = await offlineSale(5000, {
        collectedAt: collectedAt.toISOString(),
        deviceSeq: 7,
      });
      expect(intent).toMatchObject({
        status: 'captured',
        method: 'card_present',
        offline: true,
        forwardOutcome: 'pending',
        settlementPending: true,
        capturedMinor: '5000',
        offlineDeviceSeq: 7,
        offlineCollectedAt: collectedAt.toISOString(),
        providerReference: null,
        offlineExpiresAt: new Date(collectedAt.getTime() + 24 * 3_600_000).toISOString(),
        card: { last4: '4242', authCode: 'OFF123' },
      });
      expect(await readOrder(db.admin, o.orderId)).toMatchObject({
        payment_status: 'paid',
        paid_minor: 5000n,
        settlement_pending: true,
      });
      expect((await events(intent.id)).find((e) => e.kind === 'captured')!.payload).toMatchObject({
        offline: true,
        forwardOutcome: 'pending',
      });
      expect(await outbox('payment.captured', intent.id)).toBe(1);
      const open = await get('/v1/payments/intents?offlineOpen=true');
      expect(open.body.items.map((i: { id: string }) => i.id)).toContain(intent.id);

      // recording the same sale again (sync retry) returns the same intent
      const clientIntentId = key();
      const body = {
        locationId: o.locationId,
        orderId: o.orderId,
        checkId: o.checkId,
        clientIntentId,
        providerAccountId: accountId,
        terminalId,
        amountMinor: '5000',
        collectedAt: collectedAt.toISOString(),
      };
      const first = await post('/v1/payments/offline-collections', body);
      const replay = await post('/v1/payments/offline-collections', body);
      expect(replay.body.id).toBe(first.body.id);
    });

    it('forward approved: the outcome and settlement-pending clear, the order stops being "recorded only"', async () => {
      const { o, intent } = await offlineSale(2100);
      const res = await post(`/v1/payments/intents/${intent.id}/forward-outcome`, {
        outcome: 'approved',
        providerReference: 'pi_forwarded_1',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({
        forwardOutcome: 'approved',
        settlementPending: false,
        status: 'captured',
        providerReference: 'pi_forwarded_1',
      });
      expect(res.body.forwardedAt).not.toBeNull();
      expect(await readOrder(db.admin, o.orderId)).toMatchObject({
        payment_status: 'paid',
        settlement_pending: false,
      });
      // idempotent, and a different final outcome afterwards is refused
      expect(
        (await post(`/v1/payments/intents/${intent.id}/forward-outcome`, { outcome: 'approved' }))
          .status,
      ).toBe(200);
      const conflict = await post(`/v1/payments/intents/${intent.id}/forward-outcome`, {
        outcome: 'declined',
      });
      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe('FORWARD_OUTCOME_FINAL');
      expect((await events(intent.id)).map((e) => e.kind)).toEqual([
        'created',
        'submitted',
        'captured',
        'forward_approved',
      ]);
    });

    it('forward declined by the issuer: intent fails, check reopens, exception raised, event recorded', async () => {
      const { o, intent } = await offlineSale(3100);
      expect(await readOrder(db.admin, o.orderId)).toMatchObject({
        status: 'completed',
        payment_status: 'paid',
      });
      const res = await post(`/v1/payments/intents/${intent.id}/forward-outcome`, {
        outcome: 'declined',
        declineCode: 'insufficient_funds',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({
        status: 'failed',
        forwardOutcome: 'declined',
        capturedMinor: '0',
        settlementPending: false,
        lastError: { code: 'offline_declined', declineCode: 'insufficient_funds' },
      });
      expect(await readOrder(db.admin, o.orderId)).toMatchObject({
        status: 'open',
        payment_status: 'unpaid',
        paid_minor: 0n,
        reopened_reason: 'offline_payment_declined',
        settlement_pending: false,
        check_status: 'open',
      });
      const { rows } = await db.admin.query(
        "SELECT kind, from_status, to_status, payload FROM orders.order_events WHERE order_id = $1 AND kind = 'reopened_offline_decline'",
        [o.orderId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        from_status: 'completed',
        to_status: 'open',
        payload: { intentId: intent.id, reason: 'offline_payment_declined' },
      });
      expect(await exceptions(intent.id)).toMatchObject([
        {
          kind: 'offline_declined',
          severity: 'high',
          status: 'open',
          details: { orderId: o.orderId, declineCode: 'insufficient_funds', amountMinor: '3100' },
        },
      ]);
      expect(await outbox('payment.failed', intent.id)).toBe(1);
      expect((await events(intent.id)).map((e) => e.kind)).toEqual([
        'created',
        'submitted',
        'captured',
        'offline_declined',
      ]);

      // the customer is re-collected: a new intent against the reopened check works
      const cash = await post('/v1/payments/cash-tenders', {
        locationId: o.locationId,
        orderId: o.orderId,
        checkId: o.checkId,
        clientIntentId: key(),
      });
      expect(cash.status).toBe(201);
      expect(await readOrder(db.admin, o.orderId)).toMatchObject({ payment_status: 'paid' });
    });

    it('expiry sweeper: a stored payment past its window is marked expired, fails, reopens the check and raises offline_expired', async () => {
      const longAgo = new Date(Date.now() - 3 * 24 * 3_600_000);
      const { o, intent } = await offlineSale(2200, { collectedAt: longAgo.toISOString() }); // window ended 2 days ago
      const fresh = await offlineSale(2300); // window still open
      const approved = await offlineSale(2400, { collectedAt: longAgo.toISOString() });
      await post(`/v1/payments/intents/${approved.intent.id}/forward-outcome`, {
        outcome: 'approved',
      }).expect(200);

      const swept = await t.sweepers.sweep({ tenantIds: [h.tenantId] });
      expect(swept.offlineExpired).toBe(1);
      expect(await intentRow(intent.id)).toMatchObject({
        status: 'failed',
        forward_outcome: 'expired',
        captured_minor: 0n,
        settlement_pending: false,
      });
      expect(await readOrder(db.admin, o.orderId)).toMatchObject({
        status: 'open',
        payment_status: 'unpaid',
        reopened_reason: 'offline_payment_expired',
      });
      expect(await exceptions(intent.id)).toMatchObject([
        { kind: 'offline_expired', severity: 'high', status: 'open' },
      ]);
      expect((await events(intent.id)).map((e) => e.kind)).toEqual([
        'created',
        'submitted',
        'captured',
        'offline_expired',
      ]);
      expect(await outbox('payment.failed', intent.id)).toBe(1);
      expect((await intentRow(fresh.intent.id)).status).toBe('captured'); // open window: untouched
      expect(await exceptions(fresh.intent.id)).toEqual([]);
      expect((await intentRow(approved.intent.id)).status).toBe('captured'); // already forwarded: untouched
      // idempotent
      expect((await t.sweepers.sweep({ tenantIds: [h.tenantId] })).offlineExpired).toBe(0);
      expect(await exceptions(intent.id)).toHaveLength(1);

      // with a clock past the fresh window it expires too
      const later = await t.sweepers.sweep({
        tenantIds: [h.tenantId],
        now: new Date(Date.now() + 25 * 3_600_000),
      });
      expect(later.offlineExpired).toBeGreaterThanOrEqual(1);
      expect(await intentRow(fresh.intent.id)).toMatchObject({ forward_outcome: 'expired' });
    });

    it('rescue in progress keeps the sale alive until the extended window, then it expires', async () => {
      const { intent } = await offlineSale(2500);
      const extended = new Date(Date.now() + 5 * 24 * 3_600_000);
      const res = await post(`/v1/payments/intents/${intent.id}/forward-outcome`, {
        outcome: 'rescue_in_progress',
        declineCode: 'issuer_unavailable',
        expiresAt: extended.toISOString(),
      });
      expect(res.body).toMatchObject({
        forwardOutcome: 'rescue_in_progress',
        status: 'captured',
        offlineExpiresAt: extended.toISOString(),
      });
      await t.sweepers.sweep({
        tenantIds: [h.tenantId],
        now: new Date(Date.now() + 2 * 24 * 3_600_000),
      });
      expect((await intentRow(intent.id)).status).toBe('captured');
      await t.sweepers.sweep({ tenantIds: [h.tenantId], now: new Date(extended.getTime() + 1000) });
      expect(await intentRow(intent.id)).toMatchObject({
        status: 'failed',
        forward_outcome: 'expired',
      });
      // a rescue success after approval would still be accepted before expiry; after expiry it is final
      expect(
        (await post(`/v1/payments/intents/${intent.id}/forward-outcome`, { outcome: 'approved' }))
          .status,
      ).toBe(409);
    });

    it('records out-of-policy offline sales instead of dropping them, and raises offline_cap_exceeded', async () => {
      const big = await offlineSale(60_000); // per-transaction cap is 50 000
      expect((await intentRow(big.intent.id)).status).toBe('captured'); // the money moved at the terminal: recorded
      expect(await exceptions(big.intent.id)).toMatchObject([
        {
          kind: 'offline_cap_exceeded',
          severity: 'high',
          details: { reasons: ['per_transaction_cap'] },
        },
      ]);

      const cloud = await post('/v1/payments/terminals', {
        locationId: h.locationId,
        providerAccountId: accountId,
        serialNumber: 'EDGE-CLOUD',
        connectionMode: 'cloud',
      });
      const o = await order(1000);
      const res = await post('/v1/payments/offline-collections', {
        locationId: o.locationId,
        orderId: o.orderId,
        checkId: o.checkId,
        clientIntentId: key(),
        providerAccountId: accountId,
        terminalId: cloud.body.id,
        amountMinor: '1000',
        collectedAt: new Date().toISOString(),
      });
      expect(res.status).toBe(201);
      expect(await exceptions(res.body.id)).toMatchObject([
        {
          kind: 'offline_cap_exceeded',
          details: { reasons: ['connection_mode_not_offline_capable'] },
        },
      ]);

      // device count cap (1 per device): the second open offline sale from the same device trips it
      const first = await offlineSale(1100, { deviceId });
      const second = await offlineSale(1200, { deviceId });
      expect(await exceptions(first.intent.id)).toEqual([]);
      expect(await exceptions(second.intent.id)).toMatchObject([
        { kind: 'offline_cap_exceeded', details: { reasons: ['device_count_cap'] } },
      ]);
    });

    it('a terminal that loses its link approves offline only when allowed and capable; the platform records the pending forward', async () => {
      t.terminal.providerUnreachable = true;
      const o = await order(1900);
      const intent = await newIntent(o, 1900, { method: 'card_present', terminalId });
      const charges = provider.chargeCount;
      const res = await submit(intent.id, { allowOffline: true });
      expect(res.body).toMatchObject({
        status: 'captured',
        offline: true,
        forwardOutcome: 'pending',
        settlementPending: true,
        providerReference: null,
      });
      expect(res.body.offlineExpiresAt).not.toBeNull();
      expect(provider.chargeCount).toBe(charges); // nothing reached the provider
      expect(await readOrder(db.admin, o.orderId)).toMatchObject({
        payment_status: 'paid',
        settlement_pending: true,
      });
      expect((await events(intent.id)).at(-1)).toMatchObject({
        kind: 'captured',
        source: 'terminal',
      });

      // without allowOffline the terminal refuses: a certain decline, not a guess
      const o2 = await order(1910);
      const refused = await newIntent(o2, 1910, { method: 'card_present', terminalId });
      expect((await submit(refused.id)).body).toMatchObject({
        status: 'failed',
        lastError: { code: 'offline_not_allowed' },
      });
      // a cloud-connected terminal can never go offline even if asked
      const cloud = await post('/v1/payments/terminals', {
        locationId: h.locationId,
        providerAccountId: accountId,
        serialNumber: 'EDGE-CLOUD-2',
        connectionMode: 'cloud',
      });
      await post(`/v1/payments/terminals/${cloud.body.id}/pair`, { code: '123456' }).expect(200);
      const o3 = await order(1920);
      const cloudIntent = await newIntent(o3, 1920, {
        method: 'card_present',
        terminalId: cloud.body.id,
      });
      expect((await submit(cloudIntent.id, { allowOffline: true })).body).toMatchObject({
        status: 'failed',
      });
    });

    it('an offline payment cannot be refunded or reversed before it has been forwarded', async () => {
      const { intent } = await offlineSale(1600);
      const ret = await createOrderFixture(db.admin, h.tenantId, h.locationId, 0, {
        kind: 'return',
      });
      const refund = (clientRefundId: string) =>
        post(`/v1/payments/intents/${intent.id}/refunds`, {
          orderId: ret.orderId,
          clientRefundId,
          amountMinor: '100',
        });
      expect((await refund(`rf-${randomUUID()}`)).body.error.code).toBe('OFFLINE_NOT_FORWARDED');
      expect((await post(`/v1/payments/intents/${intent.id}/reverse`)).body.error.code).toBe(
        'NO_PROVIDER_REFERENCE',
      );
      await post(`/v1/payments/intents/${intent.id}/forward-outcome`, {
        outcome: 'approved',
        providerReference: 'x',
      }).expect(200);
      // forwarded: refunds would now go through the provider; this one has a synthetic reference, so it is refused by the mock
      expect((await refund(`rf-${randomUUID()}`)).status).toBe(201);
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('settlement import and reconciliation', () => {
    const importBody = (from: Date, to: Date) => ({
      providerAccountId: accountId,
      from: from.toISOString(),
      to: to.toISOString(),
    });
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    async function capture(amount: number) {
      const o = await order(amount);
      const intent = await newIntent(o, amount);
      const res = await submit(intent.id);
      expect(res.body.status).toBe('captured');
      return { o, intent, ref: provider.lastRef! };
    }

    it('matches captures and refunds, settles the intents, computes totals, and is idempotent', async () => {
      await sleep(25);
      const from = new Date();
      const a = await capture(1000);
      const b = await capture(2000);
      const ret = await createOrderFixture(db.admin, h.tenantId, h.locationId, 0, {
        kind: 'return',
      });
      await post(`/v1/payments/intents/${b.intent.id}/refunds`, {
        orderId: ret.orderId,
        clientRefundId: `rf-${randomUUID()}`,
        amountMinor: '500',
      }).expect(201);
      await sleep(25);
      const to = new Date();

      const res = await post('/v1/payments/settlements/import', importBody(from, to));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ alreadyImported: false, exceptionsRaised: 0 });
      expect(res.body.settlement).toMatchObject({
        status: 'reconciled',
        lineCount: 3,
        unmatchedCount: 0,
        grossMinor: '3000',
        refundsMinor: '500',
        chargebacksMinor: '0',
        feesMinor: String(30 + 17 + 30 + 35),
        currency: 'AUD',
      });
      expect(res.body.settlement.netMinor).toBe(String(3000 - (30 + 17 + 30 + 35) - 500));

      const detail = await get(`/v1/payments/settlements/${res.body.settlement.id}`);
      expect(
        detail.body.lines.map((l: { kind: string; matched: boolean }) => [l.kind, l.matched]),
      ).toEqual(
        expect.arrayContaining([
          ['capture', true],
          ['capture', true],
          ['refund', true],
        ]),
      );
      expect(detail.body.lines.find((l: { kind: string }) => l.kind === 'refund').amountMinor).toBe(
        '-500',
      );
      for (const p of [a, b]) {
        expect(await intentRow(p.intent.id)).toMatchObject({
          settlement_status: 'settled',
          settlement_pending: false,
        });
        expect((await events(p.intent.id)).map((e) => e.kind)).toContain('reconciled');
      }
      expect((await events(a.intent.id)).at(-1)!.source).toBe('reconciliation');

      const again = await post('/v1/payments/settlements/import', importBody(from, to));
      expect(again.body).toMatchObject({ alreadyImported: true, exceptionsRaised: 0 });
      expect(again.body.settlement.id).toBe(res.body.settlement.id);
      const { rows } = await db.admin.query(
        'SELECT COUNT(*)::int AS n FROM payments.settlement_lines WHERE settlement_id = $1',
        [res.body.settlement.id],
      );
      expect(rows[0].n).toBe(3);
      const list = await get(`/v1/payments/settlements?providerAccountId=${accountId}`);
      expect(list.body.items.map((s: { id: string }) => s.id)).toContain(res.body.settlement.id);
    });

    it('raises exceptions for amount mismatch, missing in settlement, missing in platform and a duplicate capture', async () => {
      await sleep(25);
      const from = new Date();
      const mismatch = await capture(1500);
      const dropped = await capture(800);
      const dup = await capture(900);
      const ok = await capture(950);
      provider.overrideSettlement(mismatch.ref, { amountMinor: 1499n });
      provider.overrideSettlement(dropped.ref, { drop: true });
      // a charge the provider settles that the platform never recorded
      const stray = await provider.createPayment(
        {
          account: {
            id: accountId,
            provider: 'mock',
            currency: 'AUD',
            credentialsRef: 'mock/main',
          },
          amount: money(700, 'AUD'),
          intentId: 'stray',
          capture: 'auto',
          reference: 'stray',
        },
        idempotencyKey(`stray-${randomUUID()}`),
      );
      expect(stray.outcome).toBe('approved');
      // the provider lists one capture twice
      provider.addSettlementLine({
        externalRef: `${dup.ref.providerPaymentId}:capture:dup`,
        kind: 'capture',
        amount: money(900, 'AUD'),
        feeMinor: 0n,
        occurredAt: new Date(),
        ref: dup.ref,
      });
      await sleep(25);
      const to = new Date();

      const res = await post('/v1/payments/settlements/import', importBody(from, to));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.settlement.status).toBe('exceptions');
      expect(res.body.exceptionsRaised).toBe(4);
      expect(res.body.settlement.unmatchedCount).toBeGreaterThanOrEqual(3);

      expect(await exceptions(mismatch.intent.id)).toMatchObject([
        {
          kind: 'amount_mismatch',
          details: { settlementMinor: '1499', platformCapturedMinor: '1500' },
        },
      ]);
      expect(await exceptions(dropped.intent.id)).toMatchObject([
        { kind: 'missing_in_settlement', details: { capturedMinor: '800' } },
      ]);
      expect(await exceptions(dup.intent.id)).toMatchObject([
        { kind: 'duplicate_capture_suspected', severity: 'critical' },
      ]);
      expect(await exceptions(ok.intent.id)).toEqual([]);
      const { rows } = await db.admin.query(
        "SELECT kind, details FROM payments.reconciliation_exceptions WHERE kind = 'missing_in_platform' AND details->>'externalRef' LIKE $1",
        [`${stray.outcome === 'approved' ? stray.ref.providerPaymentId : ''}%`],
      );
      expect(rows).toHaveLength(1);
      // mismatched and dropped intents are NOT marked settled
      expect(await intentRow(mismatch.intent.id)).toMatchObject({ settlement_status: 'unsettled' });
      expect(await intentRow(dropped.intent.id)).toMatchObject({ settlement_status: 'unsettled' });
      expect(await intentRow(ok.intent.id)).toMatchObject({ settlement_status: 'settled' });

      // the finance queue: list, filter, resolve with a note; resolving needs the reconcile permission
      const open = await get(
        '/v1/payments/reconciliation-exceptions?status=open&kind=missing_in_settlement',
      );
      const target = open.body.items.find(
        (e: { subjectId: string }) => e.subjectId === dropped.intent.id,
      );
      expect(target).toMatchObject({ domain: 'payments', severity: 'medium', status: 'open' });
      const noPerm = t.auth.register(
        'viewer-2',
        paymentsPrincipal(h.tenantId, { kind: 'tenant', id: h.tenantId }, ['payments.view']),
      );
      expect(
        (
          await post(
            `/v1/payments/reconciliation-exceptions/${target.id}/resolve`,
            { status: 'resolved' },
            noPerm,
          )
        ).status,
      ).toBe(403);
      const resolved = await post(`/v1/payments/reconciliation-exceptions/${target.id}/resolve`, {
        status: 'resolved',
        note: 'provider settled it next day',
      });
      expect(resolved.body).toMatchObject({
        status: 'resolved',
        resolutionNote: 'provider settled it next day',
      });
      expect(resolved.body.resolvedAt).not.toBeNull();
      expect(
        (
          await get('/v1/payments/reconciliation-exceptions?status=open&kind=missing_in_settlement')
        ).body.items.map((e: { id: string }) => e.id),
      ).not.toContain(target.id);
    });

    it('is tenant-scoped: another tenant cannot import, read or resolve', async () => {
      const list = await get(`/v1/payments/settlements`, ownerB);
      expect(list.body.items).toEqual([]);
      const foreign = await post(
        '/v1/payments/settlements/import',
        importBody(new Date(Date.now() - 1000), new Date()),
        ownerB,
      );
      expect(foreign.status).toBe(404);
      const mine = (await get('/v1/payments/settlements')).body.items[0];
      expect((await get(`/v1/payments/settlements/${mine.id}`, ownerB)).status).toBe(404);
      const anyException = (await get('/v1/payments/reconciliation-exceptions')).body.items[0];
      expect(
        (
          await post(
            `/v1/payments/reconciliation-exceptions/${anyException.id}/resolve`,
            { status: 'accepted' },
            ownerB,
          )
        ).status,
      ).toBe(404);
      expect((await get('/v1/payments/reconciliation-exceptions', ownerB)).body.items).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('cross-tenant harness over the payments routes (docs/03 §9)', () => {
    it('every payments endpoint answers 404 to a foreign tenant and to an out-of-scope principal', async () => {
      const ia = identityFixture;
      const doc = (await api().get('/v1/openapi.json').expect(200)).body;
      const operations = listOperations(doc).filter((op) => op.path.startsWith('/v1/payments'));
      expect(operations.length).toBeGreaterThanOrEqual(30);

      const base: FixtureRegistry = {
        tenantId: h.tenantId,
        rootOrgUnitId: h.rootOrgUnitId,
        childOrgUnitId: h.childOrgUnitId,
        legalEntityId: h.legalEntityId,
        locationId: h.locationId,
        otherLocationId: h.otherLocationId,
        departmentId: h.departmentId,
        registerId: h.registerId,
        otherRegisterId: h.otherRegisterId,
        ...ia,
      };
      // Resources in location A (in scope for the location-scoped manager) and in the other location (out of scope)
      const inScope = await order(100);
      const outOfScope = await order(100, h.otherLocationId);
      const intentIn = await newIntent(inScope, 100);
      const outAccount = await post('/v1/payments/provider-accounts', {
        provider: 'mock',
        name: 'Other location account',
        credentialsRef: 'mock/other',
        scopeKind: 'location',
        scopeId: h.otherLocationId,
      });
      const intentOutRes = await post('/v1/payments/intents', {
        locationId: h.otherLocationId,
        orderId: outOfScope.orderId,
        checkId: outOfScope.checkId,
        clientIntentId: key(),
        method: 'card_not_present',
        amountMinor: '100',
        providerAccountId: outAccount.body.id,
      });
      expect(intentOutRes.status, JSON.stringify(intentOutRes.body)).toBe(201);
      const terminalOut = await post('/v1/payments/terminals', {
        locationId: h.otherLocationId,
        providerAccountId: outAccount.body.id,
        serialNumber: 'OTHER-1',
        connectionMode: 'lan',
      });
      const settlementIn = (await get('/v1/payments/settlements')).body.items[0];
      const exceptionIn = (await get('/v1/payments/reconciliation-exceptions')).body.items[0];
      const resources = {
        intentId: { inScope: intentIn.id, outOfScope: intentOutRes.body.id as string },
        accountId: { inScope: accountId, outOfScope: outAccount.body.id as string },
        terminalId: { inScope: terminalId, outOfScope: terminalOut.body.id as string },
        settlementId: { inScope: settlementIn.id as string, outOfScope: settlementIn.id as string },
        exceptionId: { inScope: exceptionIn.id as string, outOfScope: exceptionIn.id as string },
      } as const;

      // x-fixture is `deviceId` for every payments path parameter (so the shared registry needs no new names);
      // each pass points `deviceId` at one resource family and skips the other families.
      expect(checkContractCompleteness(operations, { ...base, deviceId: intentIn.id })).toEqual([]);
      const paramOf = (op: (typeof operations)[number]) => op.pathParams[0]?.name;
      const invoke = async ({
        method,
        url,
        headers,
        body,
      }: {
        method: 'get' | 'post' | 'put' | 'patch' | 'delete';
        url: string;
        headers: Record<string, string>;
        body?: unknown;
      }) => {
        let req = supertest(t.server)[method](url);
        for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
        const res = body === undefined ? await req : await req.send(body as object);
        return { status: res.status, body: res.body };
      };

      let ran = 0;
      let pass = 0;
      for (const family of Object.keys(resources) as (keyof typeof resources)[]) {
        const skip: Record<string, string> = {};
        for (const op of operations) {
          const param = paramOf(op);
          if (param === undefined ? pass > 0 : param !== family)
            skip[op.operationId] = 'another pass covers it';
        }
        const report = await runCrossTenantHarness({
          doc: {
            ...doc,
            paths: Object.fromEntries(
              Object.entries(doc.paths).filter(([path]) => path.startsWith('/v1/payments')),
            ),
          },
          foreignFixtures: { ...base, deviceId: resources[family].inScope },
          outOfScopeFixtures: {
            ...base,
            locationId: h.otherLocationId,
            registerId: h.otherRegisterId,
            deviceId: resources[family].outOfScope,
          },
          tokens: { foreignTenant: ownerB, locationScoped: locationMgr },
          skip,
          invoke,
        });
        expect(report.failures, formatHarnessReport(report)).toEqual([]);
        ran += report.cases.length;
        pass += 1;
      }
      // every non-public payments operation was exercised twice (foreign tenant, out of scope)
      const exercised = operations.filter((op) => !op.isPublic && !op.isOperator).length;
      expect(ran).toBe(exercised * 2);
    }, 180_000);
  });
});
