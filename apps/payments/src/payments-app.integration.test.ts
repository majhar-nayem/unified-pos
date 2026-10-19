import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createPool, type Pool } from '@pos/db';
import {
  API_PREFIX,
  PG_POOL,
  RATE_LIMIT_CONFIG,
  RATE_LIMIT_DISABLED,
  REDIS,
} from '@pos/api/dist/modules/kernel/public/index.js';
import {
  PAYMENTS_CONFIG,
  PAYMENTS_CONFIG_DEFAULTS,
  PAYMENT_SECRETS,
  PROVIDER_REGISTRY,
  ProviderRegistry,
  StaticPaymentSecrets,
} from '@pos/api/dist/modules/payments/public/index.js';
import { MockPaymentProvider, signWebhookPayload } from '@pos/payments-sdk';
import {
  createHierarchyFixture,
  startPostgresWithSchema,
  type HierarchyFixture,
  type TestPostgres,
} from '@pos/testing';
import { Redis } from 'ioredis';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PaymentsAppModule } from './payments-app.module.js';

/**
 * The `payments` deployable: the same PaymentsModule behind its own composition root. It must
 * verify webhooks with ITS secrets, fail closed for token-authenticated routes (no authenticator
 * is bound), and run the sweepers on its own.
 */
describe('payments deployable (apps/payments)', () => {
  let db: TestPostgres;
  let app: INestApplication;
  let pool: Pool;
  let h: HierarchyFixture;
  let accountId: string;
  const SECRET = 'whsec_deployable_only_secret';
  const provider = new MockPaymentProvider({ webhookSecret: SECRET });

  async function seedIntent(status: string, updatedAt = new Date()) {
    const orderId = randomUUID();
    const checkId = randomUUID();
    const intentId = randomUUID();
    await db.admin.query(
      `INSERT INTO orders.orders (id, tenant_id, location_id, business_date, kind, currency, status, subtotal_minor, total_minor)
       VALUES ($1, $2, $3, current_date, 'retail_sale', 'AUD', 'open', 1000, 1000)`,
      [orderId, h.tenantId, h.locationId],
    );
    await db.admin.query(
      `INSERT INTO orders.checks (id, tenant_id, order_id, number, subtotal_minor, total_minor) VALUES ($1, $2, $3, 1, 1000, 1000)`,
      [checkId, h.tenantId, orderId],
    );
    await db.admin.query(
      `INSERT INTO payments.payment_intents (id, tenant_id, location_id, order_id, check_id, idempotency_key, method, amount_minor, currency, status, provider_account_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'card_not_present', 1000, 'AUD', $7, $8, $9)`,
      [
        intentId,
        h.tenantId,
        h.locationId,
        orderId,
        checkId,
        `seed:${intentId}`,
        status,
        accountId,
        updatedAt,
      ],
    );
    return { orderId, intentId };
  }

  const intentStatus = async (id: string) =>
    (await db.admin.query('SELECT status FROM payments.payment_intents WHERE id = $1', [id]))
      .rows[0].status as string;

  function signedWebhook(intentId: string, eventId: string, secret = SECRET) {
    const body = JSON.stringify({
      id: eventId,
      type: 'payment.captured',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `mock_${randomUUID().slice(0, 8)}`,
          amount: '1000',
          currency: 'AUD',
          amount_refunded: '0',
          status: 'captured',
          metadata: { tenantId: h.tenantId, intentId },
        },
      },
    });
    return {
      body,
      headers: {
        'x-mock-signature': signWebhookPayload(body, secret, Math.floor(Date.now() / 1000)),
        'content-type': 'application/json',
      },
    };
  }

  beforeAll(async () => {
    db = await startPostgresWithSchema();
    h = await createHierarchyFixture(db.admin, 'deploy-a');
    accountId = randomUUID();
    await db.admin.query(
      `INSERT INTO payments.payment_provider_accounts (id, tenant_id, provider, name, credentials_ref, currencies, settings)
       VALUES ($1, $2, 'mock', 'Mock', 'mock/deployable', '{AUD}', '{"captureMode":"auto"}')`,
      [accountId, h.tenantId],
    );
    pool = createPool({
      connectionString: db.appUrl,
      max: 6,
      applicationName: 'pos-payments-deployable-test',
    });
    // the sweeper loop belongs to this deployable: turn it on, fast
    process.env.PAYMENTS_SWEEPERS_ENABLED = 'true';
    const moduleRef = await Test.createTestingModule({ imports: [PaymentsAppModule] })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      .overrideProvider(REDIS)
      .useValue(new Redis('redis://127.0.0.1:1', { lazyConnect: true, maxRetriesPerRequest: 0 }))
      .overrideProvider(RATE_LIMIT_CONFIG)
      .useValue(RATE_LIMIT_DISABLED)
      .overrideProvider(PROVIDER_REGISTRY)
      .useValue(new ProviderRegistry().register(provider))
      .overrideProvider(PAYMENT_SECRETS)
      .useValue(new StaticPaymentSecrets({ 'mock/deployable': SECRET }))
      .overrideProvider(PAYMENTS_CONFIG)
      .useValue({ ...PAYMENTS_CONFIG_DEFAULTS, stuckAfterMs: 100, sweepIntervalMs: 150 })
      .compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    app.setGlobalPrefix(API_PREFIX);
    await app.init();
  });

  afterAll(async () => {
    delete process.env.PAYMENTS_SWEEPERS_ENABLED;
    await app?.close();
    await pool?.end().catch(() => undefined);
    await db?.stop();
  });

  it('serves the signature-verified webhook intake with its own secret: valid → processed, replay → no-op, forged → 401', async () => {
    const { orderId, intentId } = await seedIntent('processing');
    const url = `/v1/payments/webhooks/mock/${h.tenantId}/${accountId}`;
    const hook = signedWebhook(intentId, 'evt_deploy_1');
    const first = await supertest(app.getHttpServer()).post(url).set(hook.headers).send(hook.body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.status).toBe('processed');
    expect(await intentStatus(intentId)).toBe('captured');
    const order = await db.admin.query(
      'SELECT payment_status, paid_minor FROM orders.orders WHERE id = $1',
      [orderId],
    );
    expect(order.rows[0]).toMatchObject({ payment_status: 'paid', paid_minor: 1000n });

    const replay = await supertest(app.getHttpServer()).post(url).set(hook.headers).send(hook.body);
    expect(replay.body.status).toBe('duplicate');

    const other = await seedIntent('processing');
    const forged = signedWebhook(
      other.intentId,
      'evt_deploy_forged',
      'whsec_not_this_deployments_secret',
    );
    const rejected = await supertest(app.getHttpServer())
      .post(url)
      .set(forged.headers)
      .send(forged.body);
    expect(rejected.status).toBe(401);
    expect(await intentStatus(other.intentId)).toBe('processing');
    const inbox = await db.admin.query(
      "SELECT status, signature_valid FROM payments.webhook_inbox WHERE tenant_id = $1 AND status = 'invalid_signature'",
      [h.tenantId],
    );
    expect(inbox.rows).toEqual([{ status: 'invalid_signature', signature_valid: false }]);
  });

  it('fails closed for token-authenticated routes: no authenticator is bound in this deployable', async () => {
    for (const [method, path] of [
      ['get', '/v1/payments/intents'],
      ['post', '/v1/payments/cash-tenders'],
      ['get', '/v1/payments/provider-accounts'],
      ['post', '/v1/payments/settlements/import'],
    ] as const) {
      const res = await supertest(app.getHttpServer())
        [method](path)
        .set('Authorization', 'Bearer anything');
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    // and there are no identity routes to log in with
    expect((await supertest(app.getHttpServer()).post('/v1/auth/login').send({})).status).toBe(404);
  });

  it('runs the stuck-payment sweeper on its own: a crashed `processing` intent is resolved without any request', async () => {
    const { orderId, intentId } = await seedIntent('processing', new Date(Date.now() - 60_000));
    const deadline = Date.now() + 10_000;
    let status = await intentStatus(intentId);
    // processing → uncertain → captured happens inside one sweep: wait for a settled state
    while (['processing', 'uncertain'].includes(status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = await intentStatus(intentId);
    }
    expect(status).toBe('captured');
    const order = await db.admin.query('SELECT payment_status FROM orders.orders WHERE id = $1', [
      orderId,
    ]);
    expect(order.rows[0].payment_status).toBe('paid');
  }, 20_000);
});
