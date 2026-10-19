import { randomUUID } from 'node:crypto';

import {
  type FixtureRegistry,
  type HierarchyFixture,
  type TestPostgres,
  checkContractCompleteness,
  createHierarchyFixture,
  formatHarnessReport,
  listOperations,
  runCrossTenantHarness,
  startPostgresWithSchema,
} from '@pos/testing';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// This suite boots the whole AppModule, so it needs the app-level test helper (modules may not import the app shell otherwise).
/* eslint-disable boundaries/dependencies */
import {
  createTestApp,
  operatorPrincipal,
  stubFirstAdmin,
  type TestApp,
  userPrincipal,
} from '../../testing/test-app.js';
/* eslint-enable boundaries/dependencies */
import { createPricingFixture, type PricingFixture } from './fixtures.js';

/**
 * Slice F3 API: price lists, entries, assignments, promotions, scopes, coupons and the pricing
 * preview, against a real postgres:16 with RLS (app_rw role) and the real AppModule.
 */
describe('promotions module (F3 API)', () => {
  let db: TestPostgres;
  let t: TestApp;
  let a: HierarchyFixture;
  let b: HierarchyFixture;
  let fa: PricingFixture;
  let fb: PricingFixture;
  let owner: string;
  let mgrA: string;
  let cashierA: string;
  let ownerB: string;
  let operator: string;

  const api = () => supertest(t.server);
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const idem = () => ({ 'Idempotency-Key': randomUUID() });
  const ifMatch = (v: number) => ({ 'If-Match': `"${v}"` });

  const newList = async (body: object = {}, token = owner) =>
    (
      await api()
        .post('/v1/price-lists')
        .set(as(token))
        .set(idem())
        .send({ name: `List ${randomUUID().slice(0, 6)}`, currency: 'AUD', ...body })
        .expect(201)
    ).body as { id: string; version: number; status: string };

  const rules = (
    effect: object = { kind: 'percent_off', percent: '10' },
    targets: object = { all: true },
  ) => ({
    version: 1,
    targets,
    effect,
  });
  const promotionBody = (extra: object = {}) => ({
    name: `Promo ${randomUUID().slice(0, 6)}`,
    kind: 'percent_off',
    rules: rules(),
    validFrom: '2026-01-01T00:00:00Z',
    ...extra,
  });
  const newPromotion = async (extra: object = {}, token = owner) =>
    (
      await api()
        .post('/v1/promotions')
        .set(as(token))
        .set(idem())
        .send(promotionBody(extra))
        .expect(201)
    ).body as { id: string; version: number; status: string; createdBy: string | null };

  beforeAll(async () => {
    db = await startPostgresWithSchema();
    t = await createTestApp({ databaseUrl: db.appUrl, firstAdmin: stubFirstAdmin });
    a = await createHierarchyFixture(db.admin, 'pricing-a');
    b = await createHierarchyFixture(db.admin, 'pricing-b');
    fa = await createPricingFixture(db.admin, a);
    fb = await createPricingFixture(db.admin, b);
    owner = t.auth.register(
      'owner-a',
      userPrincipal(a.tenantId, { kind: 'tenant', id: a.tenantId }),
    );
    mgrA = t.auth.register(
      'mgr-a',
      userPrincipal(a.tenantId, { kind: 'location', id: a.locationId }),
    );
    cashierA = t.auth.register(
      'cashier-a',
      userPrincipal(a.tenantId, { kind: 'location', id: a.locationId }, ['catalog.view']),
    );
    ownerB = t.auth.register(
      'owner-b',
      userPrincipal(b.tenantId, { kind: 'tenant', id: b.tenantId }),
    );
    operator = t.auth.register('op', operatorPrincipal());
  });

  afterAll(async () => {
    await t?.close();
    await db?.stop();
  });

  // ---------------------------------------------------------------------------------------------
  describe('price lists', () => {
    it('create, get with ETag, update with If-Match (428, 412, 200), cursor pagination and filters', async () => {
      const created = await api()
        .post('/v1/price-lists')
        .set(as(owner))
        .set(idem())
        .send({ name: 'Members', currency: 'AUD', kind: 'member', priority: 50 })
        .expect(201);
      expect(created.body).toMatchObject({
        name: 'Members',
        currency: 'AUD',
        kind: 'member',
        taxInclusive: true,
        priority: 50,
        status: 'active',
        version: 1,
        tenantId: a.tenantId,
      });
      expect(created.headers.etag).toBe('"1"');
      const id = created.body.id as string;

      const got = await api().get(`/v1/price-lists/${id}`).set(as(owner)).expect(200);
      expect(got.headers.etag).toBe('"1"');

      await api()
        .patch(`/v1/price-lists/${id}`)
        .set(as(owner))
        .send({ name: 'Members+' })
        .expect(428);
      await api()
        .patch(`/v1/price-lists/${id}`)
        .set(as(owner))
        .set(ifMatch(9))
        .send({ name: 'Members+' })
        .expect(412);
      const updated = await api()
        .patch(`/v1/price-lists/${id}`)
        .set(as(owner))
        .set(ifMatch(1))
        .send({ name: 'Members+', taxInclusive: false })
        .expect(200);
      expect(updated.body).toMatchObject({ name: 'Members+', taxInclusive: false, version: 2 });
      expect(updated.headers.etag).toBe('"2"');
      await api()
        .patch(`/v1/price-lists/${id}`)
        .set(as(owner))
        .set(ifMatch(1))
        .send({ name: 'stale' })
        .expect(412);
      // an empty patch changes nothing and does not bump the version
      const same = await api()
        .patch(`/v1/price-lists/${id}`)
        .set(as(owner))
        .set(ifMatch(2))
        .send({})
        .expect(200);
      expect(same.body.version).toBe(2);
      // the currency is fixed at creation; unknown keys do not leak into the update
      const ignored = await api()
        .patch(`/v1/price-lists/${id}`)
        .set(as(owner))
        .set(ifMatch(2))
        .send({ currency: 'USD' })
        .expect(200);
      expect(ignored.body.currency).toBe('AUD');

      await api()
        .post('/v1/price-lists')
        .set(as(owner))
        .set(idem())
        .send({ name: 'x', currency: 'aud' })
        .expect(422);
      await api()
        .post('/v1/price-lists')
        .set(as(owner))
        .send({ name: 'x', currency: 'AUD' })
        .expect(400);

      const ids: string[] = [];
      for (let i = 0; i < 3; i++)
        ids.push((await newList({ status: 'draft', kind: 'clearance' })).id);
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: { body: { items: { id: string }[]; nextCursor: string | null } } = await api()
          .get('/v1/price-lists')
          .set(as(owner))
          .query({ kind: 'clearance', limit: 2, ...(cursor ? { cursor } : {}) })
          .expect(200);
        seen.push(...page.body.items.map((i) => i.id));
        cursor = page.body.nextCursor;
        pages += 1;
      } while (cursor);
      expect(seen).toEqual(ids);
      expect(pages).toBe(2);
      const drafts = await api()
        .get('/v1/price-lists')
        .set(as(owner))
        .query({ status: 'draft', limit: 200 })
        .expect(200);
      expect(drafts.body.items.every((l: { status: string }) => l.status === 'draft')).toBe(true);
    });

    it('only drafts can be deleted, and deletion is version-checked', async () => {
      const active = await newList();
      await api().delete(`/v1/price-lists/${active.id}`).set(as(owner)).set(ifMatch(1)).expect(409);
      await api().delete(`/v1/price-lists/${active.id}`).set(as(owner)).expect(428);
      const draft = await newList({ status: 'draft' });
      await api().delete(`/v1/price-lists/${draft.id}`).set(as(owner)).set(ifMatch(5)).expect(412);
      await api().delete(`/v1/price-lists/${draft.id}`).set(as(owner)).set(ifMatch(1)).expect(200);
      await api().get(`/v1/price-lists/${draft.id}`).set(as(owner)).expect(404);
      await api().delete(`/v1/price-lists/${draft.id}`).set(as(owner)).set(ifMatch(1)).expect(404);
    });

    it('entries: create, duplicate, foreign variant, bulk upsert, update, windows, delete; every write bumps the list version', async () => {
      const list = await newList();
      const base = `/v1/price-lists/${list.id}`;
      const first = await api()
        .post(`${base}/entries`)
        .set(as(owner))
        .set(idem())
        .set(ifMatch(1))
        .send({ variantId: fa.variantId, priceMinor: '995' })
        .expect(201);
      expect(first.body).toMatchObject({
        priceMinor: '995',
        minQuantity: '1.0000',
        validFrom: null,
        priceListVersion: 2,
      });
      await api()
        .post(`${base}/entries`)
        .set(as(owner))
        .set(idem())
        .set(ifMatch(2))
        .send({ variantId: fa.variantId, priceMinor: '1' })
        .expect(409); // same (variant, min quantity, validFrom)
      expect((await api().get(base).set(as(owner)).expect(200)).body.version).toBe(2); // the failed write rolled the bump back
      await api()
        .post(`${base}/entries`)
        .set(as(owner))
        .set(idem())
        .set(ifMatch(1))
        .send({ variantId: fa.variantId, priceMinor: '1', minQuantity: '2' })
        .expect(412);
      await api()
        .post(`${base}/entries`)
        .set(as(owner))
        .set(idem())
        .set(ifMatch(2))
        .send({ variantId: fb.variantId, priceMinor: '1' })
        .expect(404); // another tenant's variant
      await api()
        .post(`${base}/entries`)
        .set(as(owner))
        .set(idem())
        .set(ifMatch(2))
        .send({ variantId: fa.variantId, priceMinor: '-1' })
        .expect(422);
      await api()
        .post(`${base}/entries`)
        .set(as(owner))
        .set(idem())
        .set(ifMatch(2))
        .send({
          variantId: fa.variantId,
          priceMinor: '1',
          validFrom: '2026-12-01T00:00:00Z',
          validTo: '2026-11-01T00:00:00Z',
        })
        .expect(422);

      const bulk = await api()
        .post(`${base}/entries/bulk`)
        .set(as(owner))
        .set(idem())
        .set(ifMatch(2))
        .send({
          entries: [
            { variantId: fa.variantId, priceMinor: '1010' },
            { variantId: fa.variantId, priceMinor: '900', minQuantity: '6' },
            { variantId: fa.variantId, priceMinor: '850', minQuantity: '6' }, // same key: the last one wins
          ],
        })
        .expect(200);
      expect(bulk.body.priceListVersion).toBe(3);
      expect(bulk.body.entries).toHaveLength(2);
      const entries = await api()
        .get(`${base}/entries`)
        .set(as(owner))
        .query({ variantId: fa.variantId })
        .expect(200);
      const prices = Object.fromEntries(
        entries.body.items.map((e: { minQuantity: string; priceMinor: string }) => [
          e.minQuantity,
          e.priceMinor,
        ]),
      );
      expect(prices).toEqual({ '1.0000': '1010', '6.0000': '850' });
      expect(
        entries.body.items.every((e: { priceListVersion: number }) => e.priceListVersion === 3),
      ).toBe(true);
      expect(entries.body.items.find((e: { id: string }) => e.id === first.body.id)).toBeDefined(); // upsert kept the row id

      const entryId = first.body.id as string;
      const patched = await api()
        .patch(`${base}/entries/${entryId}`)
        .set(as(owner))
        .set(ifMatch(3))
        .send({ priceMinor: '1111', validFrom: '2026-12-01T00:00:00Z' })
        .expect(200);
      expect(patched.body).toMatchObject({
        priceMinor: '1111',
        validFrom: '2026-12-01T00:00:00.000Z',
        priceListVersion: 4,
      });
      await api()
        .patch(`${base}/entries/${entryId}`)
        .set(as(owner))
        .set(ifMatch(4))
        .send({ validTo: '2026-11-01T00:00:00Z' })
        .expect(422); // before the stored validFrom
      await api()
        .patch(`${base}/entries/${randomUUID()}`)
        .set(as(owner))
        .set(ifMatch(4))
        .send({ priceMinor: '1' })
        .expect(404);
      await api()
        .patch(`${base}/entries/${entryId}`)
        .set(as(owner))
        .set(ifMatch(3))
        .send({ priceMinor: '1' })
        .expect(412);

      const removed = await api()
        .delete(`${base}/entries/${entryId}`)
        .set(as(owner))
        .set(ifMatch(4))
        .expect(200);
      expect(removed.body).toMatchObject({ id: entryId, priceListVersion: 5 });
      await api().delete(`${base}/entries/${entryId}`).set(as(owner)).set(ifMatch(5)).expect(404);
      const after = await api().get(base).set(as(owner)).expect(200);
      expect(after.body.version).toBe(5);
      expect(after.headers.etag).toBe('"5"');
    });

    it('assignments: scope checks decide who may point a list where', async () => {
      const list = await newList({}, mgrA);
      const base = `/v1/price-lists/${list.id}/assignments`;
      const post = (token: string, body: object, version: number) =>
        api().post(base).set(as(token)).set(idem()).set(ifMatch(version)).send(body);

      const atA = await post(
        mgrA,
        { scopeKind: 'location', scopeId: a.locationId, priority: 20 },
        1,
      ).expect(201);
      expect(atA.body).toMatchObject({
        scopeKind: 'location',
        scopeId: a.locationId,
        priority: 20,
        priceListVersion: 2,
      });
      await post(mgrA, { scopeKind: 'location', scopeId: a.otherLocationId }, 2).expect(404); // sibling location: out of reach
      await post(mgrA, { scopeKind: 'org_unit', scopeId: a.childOrgUnitId }, 2).expect(404); // above the manager
      await post(mgrA, { scopeKind: 'tenant' }, 2).expect(404); // needs a tenant-level grant
      await post(mgrA, { scopeKind: 'channel', scopeValue: 'online' }, 2).expect(404);
      await post(mgrA, { scopeKind: 'location', scopeId: randomUUID() }, 2).expect(404); // does not exist
      await post(mgrA, { scopeKind: 'location', scopeId: b.locationId }, 2).expect(404); // another tenant's location
      await post(mgrA, { scopeKind: 'tenant', scopeId: a.tenantId }, 2).expect(422);
      await post(mgrA, { scopeKind: 'channel' }, 2).expect(422);

      const tenantWide = await post(owner, { scopeKind: 'tenant' }, 2).expect(201);
      const channel = await post(
        owner,
        { scopeKind: 'channel', scopeValue: 'online', priority: 10 },
        3,
      ).expect(201);
      expect(channel.body.priceListVersion).toBe(4);
      const listed = await api().get(base).set(as(owner)).expect(200);
      expect(listed.body.items.map((x: { scopeKind: string }) => x.scopeKind)).toEqual([
        'location',
        'tenant',
        'channel',
      ]);

      // with a tenant-wide assignment on it the list is out of the location manager's hands
      await api()
        .post(`/v1/price-lists/${list.id}/entries`)
        .set(as(mgrA))
        .set(idem())
        .set(ifMatch(4))
        .send({ variantId: fa.variantId, priceMinor: '5' })
        .expect(404);
      await api()
        .patch(`/v1/price-lists/${list.id}`)
        .set(as(mgrA))
        .set(ifMatch(4))
        .send({ name: 'mine now' })
        .expect(404);
      await api()
        .patch(`${base}/${tenantWide.body.id}`)
        .set(as(mgrA))
        .set(ifMatch(4))
        .send({ priority: 1 })
        .expect(404);
      await api().delete(`${base}/${tenantWide.body.id}`).set(as(mgrA)).set(ifMatch(4)).expect(404);

      const bumped = await api()
        .patch(`${base}/${tenantWide.body.id}`)
        .set(as(owner))
        .set(ifMatch(4))
        .send({ priority: 1 })
        .expect(200);
      expect(bumped.body).toMatchObject({ priority: 1, priceListVersion: 5 });
      await api()
        .patch(`${base}/${tenantWide.body.id}`)
        .set(as(owner))
        .set(ifMatch(4))
        .send({ priority: 2 })
        .expect(412);
      await api()
        .delete(`${base}/${tenantWide.body.id}`)
        .set(as(owner))
        .set(ifMatch(5))
        .expect(200);
      await api().delete(`${base}/${channel.body.id}`).set(as(owner)).set(ifMatch(6)).expect(200);

      // back to a list reachable only at the manager's own location: now entries are theirs to edit
      const entry = await api()
        .post(`/v1/price-lists/${list.id}/entries`)
        .set(as(mgrA))
        .set(idem())
        .set(ifMatch(7))
        .send({ variantId: fa.variantId, priceMinor: '5' })
        .expect(201);
      expect(entry.body.priceListVersion).toBe(8);
      await api().get(base).set(as(mgrA)).expect(200);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('promotions', () => {
    it('create validates the rules DSL, enforces unique codes and records the creator', async () => {
      const created = await api()
        .post('/v1/promotions')
        .set(as(owner))
        .set(idem())
        .send(
          promotionBody({
            code: 'TEN-DRINKS',
            rules: rules({ kind: 'percent_off', percent: '10' }, { tags: ['drink'] }),
            schedule: { daysOfWeek: [1, 2, 3, 4, 5], windows: [{ from: '16:00', to: '18:00' }] },
            scopes: [{ scopeKind: 'location', scopeId: a.locationId }],
            stackGroup: 'seasonal',
          }),
        )
        .expect(201);
      expect(created.body).toMatchObject({
        code: 'TEN-DRINKS',
        status: 'draft',
        version: 1,
        priority: 100,
        usesCount: 0,
        spentMinor: '0',
        isExclusive: false,
        requiresCoupon: false,
        stackGroup: 'seasonal',
        schedule: { daysOfWeek: [1, 2, 3, 4, 5], windows: [{ from: '16:00', to: '18:00' }] },
      });
      expect(created.body.createdBy).toEqual(expect.any(String));
      const scopes = await api()
        .get(`/v1/promotions/${created.body.id}/scopes`)
        .set(as(owner))
        .expect(200);
      expect(scopes.body.items).toHaveLength(1);
      expect(scopes.body.items[0]).toMatchObject({
        scopeKind: 'location',
        scopeId: a.locationId,
        promotionVersion: 1,
      });

      await api()
        .post('/v1/promotions')
        .set(as(owner))
        .set(idem())
        .send(promotionBody({ code: 'TEN-DRINKS' }))
        .expect(409);
      for (const bad of [
        promotionBody({ rules: rules({ kind: 'percent_off', percent: '150' }) }),
        promotionBody({ rules: { ...rules(), extra: 1 } }),
        promotionBody({ rules: rules({ kind: 'amount_off', amountMinor: '5', per: 'order' }) }), // kind says percent_off
        promotionBody({ kind: 'loyalty_price' }),
        promotionBody({ validTo: '2025-01-01T00:00:00Z' }),
        promotionBody({ scopes: [{ scopeKind: 'location' }] }),
      ]) {
        await api().post('/v1/promotions').set(as(owner)).set(idem()).send(bad).expect(422);
      }
      // a location scope that does not exist rolls the whole create back
      const before = (
        await api().get('/v1/promotions').set(as(owner)).query({ limit: 200 }).expect(200)
      ).body.items.length;
      await api()
        .post('/v1/promotions')
        .set(as(owner))
        .set(idem())
        .send(promotionBody({ scopes: [{ scopeKind: 'location', scopeId: randomUUID() }] }))
        .expect(404);
      expect(
        (await api().get('/v1/promotions').set(as(owner)).query({ limit: 200 }).expect(200)).body
          .items.length,
      ).toBe(before);
    });

    it('status moves follow the lifecycle; PATCH is version-checked and cross-validated', async () => {
      const p = await newPromotion();
      const patch = (version: number, body: object) =>
        api().patch(`/v1/promotions/${p.id}`).set(as(owner)).set(ifMatch(version)).send(body);
      await patch(1, { status: 'paused' }).expect(409); // draft cannot pause
      await patch(1, { kind: 'bogo' }).expect(422); // rules are still percent_off
      await patch(1, { validTo: '2025-01-01T00:00:00Z' }).expect(422); // before the stored validFrom
      await patch(1, {
        rules: rules({ kind: 'amount_off', amountMinor: '100', per: 'order' }),
      }).expect(422);
      const activated = await patch(1, { status: 'active' }).expect(200);
      expect(activated.body).toMatchObject({ status: 'active', version: 2 });
      await patch(1, { status: 'paused' }).expect(412);
      const retargeted = await patch(2, {
        kind: 'amount_off',
        rules: rules({ kind: 'amount_off', amountMinor: '100', per: 'order' }),
      }).expect(200);
      expect(retargeted.body).toMatchObject({ kind: 'amount_off', version: 3 });
      await patch(3, { status: 'draft' }).expect(409);
      await patch(3, { status: 'paused' }).expect(200);
      await patch(4, { status: 'active' }).expect(200);
      await patch(5, { status: 'ended' }).expect(200);
      const err = await patch(6, { status: 'active' }).expect(409);
      expect(err.body.error).toMatchObject({
        code: 'INVALID_STATUS_TRANSITION',
        details: { from: 'ended', to: 'active', allowed: ['archived'] },
      });
      await patch(6, { status: 'archived' }).expect(200);
      await patch(7, { status: 'active' }).expect(409);
      const same = await patch(7, {}).expect(200);
      expect(same.body.version).toBe(7);
    });

    it('scopes are part of the promotion aggregate: writes need and bump its version', async () => {
      const p = await newPromotion();
      const base = `/v1/promotions/${p.id}/scopes`;
      const scope = await api()
        .post(base)
        .set(as(owner))
        .set(idem())
        .set(ifMatch(1))
        .send({ scopeKind: 'channel', scopeValue: 'online' })
        .expect(201);
      expect(scope.body.promotionVersion).toBe(2);
      await api()
        .post(base)
        .set(as(owner))
        .set(idem())
        .set(ifMatch(1))
        .send({ scopeKind: 'location', scopeId: a.locationId })
        .expect(412);
      await api()
        .post(base)
        .set(as(owner))
        .set(idem())
        .set(ifMatch(2))
        .send({ scopeKind: 'channel', scopeValue: 'online' })
        .expect(409); // unique (promotion, kind, id, value)
      expect(
        (await api().get(`/v1/promotions/${p.id}`).set(as(owner)).expect(200)).body.version,
      ).toBe(2);
      await api().delete(`${base}/${scope.body.id}`).set(as(owner)).set(ifMatch(1)).expect(412);
      await api().delete(`${base}/${randomUUID()}`).set(as(owner)).set(ifMatch(2)).expect(404);
      const removed = await api()
        .delete(`${base}/${scope.body.id}`)
        .set(as(owner))
        .set(ifMatch(2))
        .expect(200);
      expect(removed.body.promotionVersion).toBe(3);
      expect((await api().get(base).set(as(owner)).expect(200)).body.items).toEqual([]);
    });

    it('a location manager may only create and edit promotions inside their reach', async () => {
      await api()
        .post('/v1/promotions')
        .set(as(mgrA))
        .set(idem())
        .send(promotionBody())
        .expect(404); // no scopes = tenant-wide
      await api()
        .post('/v1/promotions')
        .set(as(mgrA))
        .set(idem())
        .send(promotionBody({ scopes: [{ scopeKind: 'location', scopeId: a.otherLocationId }] }))
        .expect(404);
      await api()
        .post('/v1/promotions')
        .set(as(mgrA))
        .set(idem())
        .send(promotionBody({ scopes: [{ scopeKind: 'channel', scopeValue: 'pos' }] }))
        .expect(404);
      const mine = await api()
        .post('/v1/promotions')
        .set(as(mgrA))
        .set(idem())
        .send(promotionBody({ scopes: [{ scopeKind: 'location', scopeId: a.locationId }] }))
        .expect(201);
      await api()
        .patch(`/v1/promotions/${mine.body.id}`)
        .set(as(mgrA))
        .set(ifMatch(1))
        .send({ name: 'Mine, renamed' })
        .expect(200);
      await api()
        .post(`/v1/promotions/${mine.body.id}/scopes`)
        .set(as(mgrA))
        .set(idem())
        .set(ifMatch(2))
        .send({ scopeKind: 'location', scopeId: a.otherLocationId })
        .expect(404);

      const tenantWide = await newPromotion();
      await api()
        .patch(`/v1/promotions/${tenantWide.id}`)
        .set(as(mgrA))
        .set(ifMatch(1))
        .send({ name: 'hijack' })
        .expect(404);
      await api()
        .delete(`/v1/promotions/${tenantWide.id}`)
        .set(as(mgrA))
        .set(ifMatch(1))
        .expect(404);
      await api()
        .post(`/v1/promotions/${tenantWide.id}/coupons`)
        .set(as(mgrA))
        .set(idem())
        .send({ code: 'HIJACK-1' })
        .expect(404);
      await api().get(`/v1/promotions/${tenantWide.id}`).set(as(mgrA)).expect(200); // reads need only the view permission
    });

    it('only drafts can be deleted; list filters and cursor pagination', async () => {
      const draft = await newPromotion();
      const live = await newPromotion({
        status: 'active',
        kind: 'bogo',
        rules: rules({ kind: 'bogo', buyQuantity: 1, getQuantity: 1 }),
      });
      await api().delete(`/v1/promotions/${live.id}`).set(as(owner)).set(ifMatch(1)).expect(409);
      await api().delete(`/v1/promotions/${draft.id}`).set(as(owner)).set(ifMatch(2)).expect(412);
      await api().delete(`/v1/promotions/${draft.id}`).set(as(owner)).set(ifMatch(1)).expect(200);
      await api().get(`/v1/promotions/${draft.id}`).set(as(owner)).expect(404);

      const bogos = await api()
        .get('/v1/promotions')
        .set(as(owner))
        .query({ kind: 'bogo', status: 'active' })
        .expect(200);
      expect(bogos.body.items.map((p: { id: string }) => p.id)).toContain(live.id);
      expect(bogos.body.items.every((p: { kind: string }) => p.kind === 'bogo')).toBe(true);
      const future = await newPromotion({ validFrom: '2030-01-01T00:00:00Z', code: 'FUTURE-1' });
      const now = await api()
        .get('/v1/promotions')
        .set(as(owner))
        .query({ activeAt: '2026-10-19T00:00:00Z', limit: 200 })
        .expect(200);
      expect(now.body.items.map((p: { id: string }) => p.id)).not.toContain(future.id);
      const later = await api()
        .get('/v1/promotions')
        .set(as(owner))
        .query({ activeAt: '2031-01-01T00:00:00Z', limit: 200 })
        .expect(200);
      expect(later.body.items.map((p: { id: string }) => p.id)).toContain(future.id);
      const page1 = await api()
        .get('/v1/promotions')
        .set(as(owner))
        .query({ limit: 2 })
        .expect(200);
      expect(page1.body.items).toHaveLength(2);
      const page2 = await api()
        .get('/v1/promotions')
        .set(as(owner))
        .query({ limit: 2, cursor: page1.body.nextCursor })
        .expect(200);
      expect(page2.body.items[0].id > page1.body.items[1].id).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('coupons', () => {
    it('create (upper-cased), duplicate, list filters, limits, void', async () => {
      const p = await newPromotion({ requiresCoupon: true });
      const create = (body: object, token = owner) =>
        api().post(`/v1/promotions/${p.id}/coupons`).set(as(token)).set(idem()).send(body);
      const c = await create({
        code: 'save-10_x',
        maxUses: 3,
        expiresAt: '2030-01-01T00:00:00Z',
      }).expect(201);
      expect(c.body).toMatchObject({
        code: 'SAVE-10_X',
        maxUses: 3,
        usesCount: 0,
        status: 'active',
        promotionId: p.id,
        customerId: null,
        expiresAt: '2030-01-01T00:00:00.000Z',
      });
      await create({ code: 'SAVE-10_X' }).expect(409); // case-insensitive uniqueness
      await create({ code: 'abc' }).expect(422);
      await api()
        .post(`/v1/promotions/${randomUUID()}/coupons`)
        .set(as(owner))
        .set(idem())
        .send({ code: 'NOPE-0001' })
        .expect(404);

      const byCode = await api()
        .get('/v1/coupons')
        .set(as(owner))
        .query({ code: 'save-10_x' })
        .expect(200);
      expect(byCode.body.items.map((i: { id: string }) => i.id)).toEqual([c.body.id]);
      const byPromo = await api()
        .get('/v1/coupons')
        .set(as(owner))
        .query({ promotionId: p.id, status: 'active' })
        .expect(200);
      expect(byPromo.body.items).toHaveLength(1);
      await api().get(`/v1/coupons/${c.body.id}`).set(as(owner)).expect(200);

      // the order slice redeems coupons; simulate two redemptions
      await db.admin.query('UPDATE pricing.coupons SET uses_count = 2 WHERE id = $1', [c.body.id]);
      const low = await api()
        .patch(`/v1/coupons/${c.body.id}`)
        .set(as(owner))
        .send({ maxUses: 1 })
        .expect(422);
      expect(JSON.stringify(low.body)).toContain('2 redemptions');
      const raised = await api()
        .patch(`/v1/coupons/${c.body.id}`)
        .set(as(owner))
        .send({ maxUses: 10, expiresAt: null })
        .expect(200);
      expect(raised.body).toMatchObject({ maxUses: 10, expiresAt: null, usesCount: 2 });
      await api()
        .patch(`/v1/coupons/${c.body.id}`)
        .set(as(owner))
        .send({ status: 'active' })
        .expect(422);
      const voided = await api()
        .patch(`/v1/coupons/${c.body.id}`)
        .set(as(owner))
        .send({ status: 'void' })
        .expect(200);
      expect(voided.body.status).toBe('void');
      const err = await api()
        .patch(`/v1/coupons/${c.body.id}`)
        .set(as(owner))
        .send({ maxUses: 20 })
        .expect(409);
      expect(err.body.error.code).toBe('COUPON_NOT_ACTIVE');
      await api()
        .patch(`/v1/coupons/${randomUUID()}`)
        .set(as(owner))
        .send({ maxUses: 2 })
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('audit trail and outbox', () => {
    it('every write is audited with before/after and emits a change event in the same transaction', async () => {
      const list = await newList({ name: 'Audited' });
      await api()
        .patch(`/v1/price-lists/${list.id}`)
        .set(as(owner))
        .set(ifMatch(1))
        .send({ name: 'Audited v2' })
        .expect(200);
      await api()
        .post(`/v1/price-lists/${list.id}/entries`)
        .set(as(owner))
        .set(idem())
        .set(ifMatch(2))
        .send({ variantId: fa.variantId, priceMinor: '5' })
        .expect(201);

      const audit = await db.admin.query<{
        action: string;
        before: unknown;
        after: { name?: string } | null;
      }>(
        'SELECT action, before, after FROM audit.audit_log WHERE tenant_id = $1 AND resource_id = $2 ORDER BY seq',
        [a.tenantId, list.id],
      );
      expect(audit.rows.map((r) => r.action)).toEqual([
        'pricing.price_list.created',
        'pricing.price_list.updated',
        'pricing.price_list.entry_created',
      ]);
      expect(audit.rows[1]!.after?.name).toBe('Audited v2');
      expect((audit.rows[1]!.before as { name: string }).name).toBe('Audited');

      const events = await db.admin.query<{
        event_type: string;
        aggregate_version: number;
        payload: { entity: string; change: string };
      }>(
        'SELECT event_type, aggregate_version, payload FROM audit.outbox_events WHERE tenant_id = $1 AND aggregate_id = $2 ORDER BY occurred_at, aggregate_version',
        [a.tenantId, list.id],
      );
      expect(
        events.rows.map((e) => [
          e.event_type,
          e.payload.entity,
          e.payload.change,
          e.aggregate_version,
        ]),
      ).toEqual([
        ['pricing.price_list.changed', 'price_list', 'created', 1],
        ['pricing.price_list.changed', 'price_list', 'updated', 2],
        ['pricing.price_list.changed', 'entry', 'updated', 3],
      ]);

      // a failed write leaves neither audit nor events behind
      const countAudit = async () =>
        Number(
          (
            await db.admin.query('SELECT count(*) FROM audit.audit_log WHERE tenant_id = $1', [
              a.tenantId,
            ])
          ).rows[0].count,
        );
      const beforeCount = await countAudit();
      await api()
        .post(`/v1/price-lists/${list.id}/entries`)
        .set(as(owner))
        .set(idem())
        .set(ifMatch(3))
        .send({ variantId: fa.variantId, priceMinor: '6' })
        .expect(409);
      expect(await countAudit()).toBe(beforeCount);

      const promo = await newPromotion({ code: 'AUDITED-1' });
      const promoAudit = await db.admin.query<{ action: string; actor_kind: string }>(
        'SELECT action, actor_kind FROM audit.audit_log WHERE tenant_id = $1 AND resource_id = $2',
        [a.tenantId, promo.id],
      );
      expect(promoAudit.rows).toEqual([
        { action: 'pricing.promotion.created', actor_kind: 'user' },
      ]);
      const op = await api()
        .post('/v1/promotions')
        .set(as(operator))
        .set(idem())
        .send(promotionBody())
        .expect(404); // operators have no tenant
      expect(op.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('POST /v1/pricing/preview', () => {
    // A tenant of its own: the other suites leave active tenant-wide promotions behind, and a
    // preview must be priced against exactly the configuration this block sets up.
    let a: HierarchyFixture;
    let fa: PricingFixture;
    let owner: string;
    let mgrA: string;
    let cashierA: string;
    let couponCode: string;
    const preview = (token: string, body: object) =>
      api().post('/v1/pricing/preview').set(as(token)).send(body);
    const draft = (extra: object = {}, lineExtra: object = {}) => ({
      currency: 'AUD',
      lines: [
        {
          id: 'l1',
          variantId: fa.variantId,
          quantity: '2',
          defaultUnitPriceMinor: '1000',
          ...lineExtra,
        },
      ],
      ...extra,
    });

    beforeAll(async () => {
      a = await createHierarchyFixture(db.admin, 'pricing-preview');
      fa = await createPricingFixture(db.admin, a);
      owner = t.auth.register(
        'owner-p',
        userPrincipal(a.tenantId, { kind: 'tenant', id: a.tenantId }),
      );
      mgrA = t.auth.register(
        'mgr-p',
        userPrincipal(a.tenantId, { kind: 'location', id: a.locationId }),
      );
      cashierA = t.auth.register(
        'cashier-p',
        userPrincipal(a.tenantId, { kind: 'location', id: a.locationId }, ['catalog.view']),
      );
      couponCode = (await api().get(`/v1/coupons/${fa.couponId}`).set(as(owner)).expect(200)).body
        .code;
    });

    it('prices a draft with the price list and promotion loaded from the database', async () => {
      const res = await preview(cashierA, {
        locationId: a.locationId,
        draft: draft({ couponCodes: [couponCode.toLowerCase()] }),
      }).expect(200);
      // list price 900 (location assignment) x 2 = 1800; coupon promotion 10% = 180
      expect(res.body).toMatchObject({
        currency: 'AUD',
        subtotalMinor: '1800',
        promotionDiscountMinor: '180',
        netMinor: '1620',
        totalMinor: '1620',
        taxMinor: '147',
        roundingMinor: '0',
        amountDueMinor: '1620',
      });
      expect(res.body.lines[0].priceSource).toEqual({
        kind: 'price_list',
        priceListId: fa.priceListId,
        entryId: fa.priceListEntryId,
      });
      expect(res.body.promotions[0]).toMatchObject({
        promotionId: fa.promotionId,
        couponId: fa.couponId,
        amountMinor: '180',
      });
      expect(res.body.trace.length).toBeGreaterThan(2);
      expect(res.body.trace[0]).toMatchObject({ seq: 1, step: 'price_resolution' });
      expect(JSON.stringify(res.body)).not.toMatch(/\d+n"/);
    });

    it('without the coupon the promotion is skipped and said so; trace can be dropped', async () => {
      const res = await preview(cashierA, {
        locationId: a.locationId,
        includeTrace: false,
        draft: draft(),
      }).expect(200);
      expect(res.body).toMatchObject({
        totalMinor: '1800',
        promotionDiscountMinor: '0',
        trace: [],
      });
      expect(res.body.skippedPromotions).toEqual([
        { promotionId: fa.promotionId, reason: 'coupon_required' },
      ]);
    });

    it('honours tender, cash rounding, tax rules and per-request context', async () => {
      const cash = await preview(owner, {
        locationId: a.locationId,
        draft: {
          currency: 'AUD',
          lines: [
            { id: 'l1', variantId: randomUUID(), quantity: '1', defaultUnitPriceMinor: '1003' },
          ],
          tenders: [{ method: 'cash' }],
        },
      }).expect(200);
      expect(cash.body).toMatchObject({
        totalMinor: '1003',
        roundingMinor: '2',
        amountDueMinor: '1005',
      });
      const noRounding = await preview(owner, {
        locationId: a.locationId,
        cashRounding: null,
        draft: {
          currency: 'AUD',
          lines: [
            { id: 'l1', variantId: randomUUID(), quantity: '1', defaultUnitPriceMinor: '1003' },
          ],
          tenders: [{ method: 'cash' }],
        },
      }).expect(200);
      expect(noRounding.body.roundingMinor).toBe('0');
      const taxed = await preview(owner, {
        locationId: a.locationId,
        taxRules: [
          {
            id: 'sales',
            name: 'Sales tax',
            taxClassId: null,
            rate: '0.080000',
            inclusiveDefault: false,
          },
        ],
        draft: {
          currency: 'USD',
          lines: [
            { id: 'l1', variantId: randomUUID(), quantity: '1', defaultUnitPriceMinor: '10000' },
          ],
        },
      }).expect(200);
      expect(taxed.body).toMatchObject({ netMinor: '10000', taxMinor: '800', totalMinor: '10800' });
      expect(taxed.body.taxSummary).toEqual([
        {
          ruleId: 'sales',
          name: 'Sales tax',
          rate: '0.080000',
          taxableMinor: '10000',
          taxMinor: '800',
        },
      ]);
    });

    it('a schedule is evaluated in the supplied time zone', async () => {
      const happy = await newPromotion(
        {
          status: 'active',
          rules: rules({ kind: 'percent_off', percent: '20' }, { tags: ['drink'] }),
          schedule: { daysOfWeek: [1], windows: [{ from: '16:00', to: '18:00' }] },
        },
        owner,
      );
      const body = (at: string, timezone: string) => ({
        locationId: a.locationId,
        at,
        timezone,
        draft: {
          currency: 'AUD',
          lines: [
            {
              id: 'l1',
              variantId: randomUUID(),
              quantity: '1',
              defaultUnitPriceMinor: '500',
              tags: ['drink'],
            },
          ],
        },
      });
      const inside = await preview(owner, body('2026-10-19T05:30:00Z', 'Australia/Sydney')).expect(
        200,
      );
      expect(inside.body.promotions.map((p: { promotionId: string }) => p.promotionId)).toEqual([
        happy.id,
      ]);
      expect(inside.body.promotionDiscountMinor).toBe('100');
      const outside = await preview(owner, body('2026-10-19T02:00:00Z', 'Australia/Sydney')).expect(
        200,
      );
      expect(outside.body.promotionDiscountMinor).toBe('0');
      expect(
        outside.body.skippedPromotions.some(
          (s: { promotionId: string; reason: string }) =>
            s.promotionId === happy.id && s.reason === 'outside_schedule',
        ),
      ).toBe(true);
      const utc = await preview(owner, body('2026-10-19T05:30:00Z', 'UTC')).expect(200);
      expect(utc.body.promotionDiscountMinor).toBe('0'); // 05:30 UTC is not in the 16:00-18:00 window
    });

    it('is scoped: foreign locations and tenants see only their own configuration', async () => {
      await preview(mgrA, { locationId: a.otherLocationId, draft: draft() }).expect(404);
      await preview(cashierA, { locationId: a.otherLocationId, draft: draft() }).expect(404);
      await preview(owner, { locationId: randomUUID(), draft: draft() }).expect(404);
      await preview(ownerB, { locationId: a.locationId, draft: draft() }).expect(404);
      // tenant B has its own list (900) and promotion for the same kind of draft, but none of tenant A's rows apply
      const resB = await preview(ownerB, {
        locationId: b.locationId,
        draft: draft({}, { variantId: fb.variantId }),
      }).expect(200);
      expect(resB.body.lines[0].priceSource.priceListId).toBe(fb.priceListId);
      expect(JSON.stringify(resB.body)).not.toContain(fa.priceListId);
      expect(JSON.stringify(resB.body)).not.toContain(fa.promotionId);
      // the same variant id in tenant A's list is invisible to tenant B's preview
      const resB2 = await preview(ownerB, {
        locationId: b.locationId,
        draft: draft({}, { variantId: fa.variantId }),
      }).expect(200);
      expect(resB2.body.lines[0].priceSource).toEqual({ kind: 'variant_default' });
      await preview(operator, { locationId: a.locationId, draft: draft() }).expect(404);
    });

    it('rejects unpriceable or invalid drafts with 422', async () => {
      const nothing = await preview(owner, {
        locationId: a.locationId,
        draft: { currency: 'AUD', lines: [{ id: 'l1', variantId: randomUUID(), quantity: '1' }] },
      }).expect(422);
      expect(JSON.stringify(nothing.body)).toContain('no price list prices variant');
      await preview(owner, {
        locationId: a.locationId,
        draft: { currency: 'ZZZ', lines: [] },
      }).expect(422);
      await preview(owner, {
        locationId: a.locationId,
        draft: draft({ tenders: [{ method: 'card', amountMinor: '999999' }, { method: 'cash' }] }),
      }).expect(422);
      await preview(owner, {
        locationId: a.locationId,
        draft: draft({ manualDiscounts: [{ id: 'd', kind: 'percent', value: '101' }] }),
      }).expect(422);
      await preview(owner, { locationId: a.locationId }).expect(422);
      await preview(owner, { draft: draft() }).expect(404); // the scope guard cannot place the request without a location
      await api()
        .post('/v1/pricing/preview')
        .send({ locationId: a.locationId, draft: draft() })
        .expect(401);
    });

    it('manual discounts and overrides carry their authorisation into the response', async () => {
      const res = await preview(owner, {
        locationId: a.locationId,
        draft: {
          currency: 'AUD',
          lines: [
            {
              id: 'l1',
              variantId: fa.variantId,
              quantity: '1',
              priceOverride: {
                unitPriceMinor: '800',
                authorization: { authorizedBy: 'mgr-7', approvalId: 'ap-1', method: 'pin' },
              },
              manualDiscount: {
                id: 'd1',
                kind: 'percent',
                value: '10',
                authorization: { authorizedBy: 'mgr-7', method: 'pin' },
              },
            },
          ],
          manualDiscounts: [
            { id: 'od', kind: 'amount', value: '20', authorization: { authorizedBy: 'mgr-2' } },
          ],
        },
      }).expect(200);
      expect(res.body.lines[0].priceSource).toEqual({
        kind: 'override',
        authorizedBy: 'mgr-7',
        approvalId: 'ap-1',
      });
      expect(res.body).toMatchObject({
        lineDiscountMinor: '80',
        orderDiscountMinor: '20',
        totalMinor: '700',
      });
      expect(res.body.orderDiscounts).toEqual([
        { id: 'od', amountMinor: '20', authorization: { authorizedBy: 'mgr-2' } },
      ]);
      expect(res.body.trace.find((x: { step: string }) => x.step === 'line_discount').detail).toBe(
        '10% authorized by mgr-7 via pin',
      );
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('permissions', () => {
    it('read-only users read and preview but cannot write', async () => {
      await api().get('/v1/price-lists').set(as(cashierA)).expect(200);
      await api().get('/v1/promotions').set(as(cashierA)).expect(200);
      await api().get('/v1/coupons').set(as(cashierA)).expect(200);
      await api().get(`/v1/price-lists/${fa.priceListId}`).set(as(cashierA)).expect(200);
      const denied = await api()
        .post('/v1/price-lists')
        .set(as(cashierA))
        .set(idem())
        .send({ name: 'x', currency: 'AUD' })
        .expect(403);
      expect(denied.body.error.code).toBe('PERMISSION_DENIED');
      await api()
        .post('/v1/promotions')
        .set(as(cashierA))
        .set(idem())
        .send(promotionBody())
        .expect(403);
      await api()
        .patch(`/v1/coupons/${fa.couponId}`)
        .set(as(cashierA))
        .send({ status: 'void' })
        .expect(403);
      await api()
        .delete(`/v1/promotions/${fa.draftPromotionId}`)
        .set(as(cashierA))
        .set(ifMatch(1))
        .expect(403);
    });

    it('a user without any pricing permission reads nothing', async () => {
      const nobody = t.auth.register(
        'nobody-a',
        userPrincipal(a.tenantId, { kind: 'location', id: a.locationId }, [
          'tenancy.location.view',
        ]),
      );
      await api().get('/v1/price-lists').set(as(nobody)).expect(403);
      await api()
        .post('/v1/pricing/preview')
        .set(as(nobody))
        .send({ locationId: a.locationId, draft: { currency: 'AUD', lines: [] } })
        .expect(403);
    });
  });

  // ---------------------------------------------------------------------------------------------
  it('cross-tenant harness: every pricing operation answers 404 to a foreign tenant and never leaks ids to an out-of-scope principal', async () => {
    const foreignTenant = t.auth.register(
      'harness-owner-b',
      userPrincipal(b.tenantId, { kind: 'tenant', id: b.tenantId }),
    );
    const locationScoped = t.auth.register(
      'harness-mgr-a',
      userPrincipal(a.tenantId, { kind: 'location', id: a.locationId }),
    );
    const fixturesA: FixtureRegistry = {
      tenantId: a.tenantId,
      rootOrgUnitId: a.rootOrgUnitId,
      childOrgUnitId: a.childOrgUnitId,
      locationId: a.locationId,
      otherLocationId: a.otherLocationId,
      registerId: a.registerId,
      ...fa,
    };
    const outOfScope: FixtureRegistry = { ...fixturesA, locationId: a.otherLocationId };
    const full = (await api().get('/v1/openapi.json').expect(200)).body as {
      paths: Record<string, unknown>;
    };
    const pricingOnly = {
      ...full,
      paths: Object.fromEntries(
        Object.entries(full.paths)
          .map(
            ([path, ops]) =>
              [
                path,
                Object.fromEntries(
                  Object.entries(ops as Record<string, { operationId: string }>).filter(([, op]) =>
                    /^pricing\.(price_list|promotion|coupon|preview)/.test(op.operationId),
                  ),
                ),
              ] as const,
          )
          .filter(([, ops]) => Object.keys(ops).length > 0),
      ),
    };
    const operations = listOperations(pricingOnly);
    expect(operations.length).toBe(27);
    expect(checkContractCompleteness(operations, fixturesA)).toEqual([]);

    const report = await runCrossTenantHarness({
      doc: pricingOnly,
      foreignFixtures: fixturesA,
      outOfScopeFixtures: outOfScope,
      tokens: { foreignTenant, locationScoped },
      invoke: async ({ method, url, headers, body }) => {
        let req = supertest(t.server)[method](url);
        for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
        const res = body === undefined ? await req : await req.send(body as object);
        return { status: res.status, body: res.body };
      },
    });
    expect(report.failures, formatHarnessReport(report)).toEqual([]);
    expect(report.cases.length).toBe(operations.length * 2);
  }, 120_000);
});
