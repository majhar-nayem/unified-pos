import { randomUUID } from 'node:crypto';

import {
  createHierarchyFixture,
  startPostgresWithSchema,
  type HierarchyFixture,
  type TestPostgres,
} from '@pos/testing';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestApp,
  operatorPrincipal,
  stubFirstAdmin,
  type TestApp,
  userPrincipal,
} from './testing/test-app.js';

describe('tenancy module (F1 acceptance)', () => {
  let db: TestPostgres;
  let t: TestApp;
  let fx: HierarchyFixture;
  let owner: string;
  let locationAManager: string;
  let operator: string;

  const api = () => supertest(t.server);
  const idem = () => ({ 'Idempotency-Key': randomUUID() });

  beforeAll(async () => {
    db = await startPostgresWithSchema();
    t = await createTestApp({ databaseUrl: db.appUrl, firstAdmin: stubFirstAdmin });
    fx = await createHierarchyFixture(db.admin, 'acme');
    owner = t.auth.register(
      'owner',
      userPrincipal(fx.tenantId, { kind: 'tenant', id: fx.tenantId }),
    );
    locationAManager = t.auth.register(
      'mgr-a',
      userPrincipal(fx.tenantId, { kind: 'location', id: fx.locationId }),
    );
    operator = t.auth.register('op', operatorPrincipal());
  });

  afterAll(async () => {
    await t?.close();
    await db?.stop();
  });

  it('GET /v1/tenants/me returns the caller’s tenant and never another', async () => {
    const res = await api()
      .get('/v1/tenants/me')
      .set('Authorization', `Bearer ${owner}`)
      .expect(200);
    expect(res.body).toMatchObject({ id: fx.tenantId, slug: 'acme', defaultCurrency: 'AUD' });
    await api().get('/v1/tenants/me').expect(401);
    await api().get('/v1/tenants/me').set('Authorization', `Bearer ${operator}`).expect(404);
  });

  it('a user scoped to Location A gets 200 for A and 404 for Location B (acceptance)', async () => {
    const h = { Authorization: `Bearer ${locationAManager}` };
    await api().get(`/v1/locations/${fx.locationId}`).set(h).expect(200);
    await api().get(`/v1/locations/${fx.otherLocationId}`).set(h).expect(404);
    await api().get(`/v1/registers/${fx.registerId}`).set(h).expect(200);
    await api().get(`/v1/registers/${fx.otherRegisterId}`).set(h).expect(404);
    await api()
      .patch(`/v1/locations/${fx.otherLocationId}`)
      .set(h)
      .set('If-Match', '"1"')
      .send({ name: 'x' })
      .expect(404);
    await api().get(`/v1/org-units/${fx.rootOrgUnitId}`).set(h).expect(404);
    await api().get('/v1/not-a-uuid').set(h).expect(404);
    await api().get('/v1/locations/not-a-uuid').set(h).expect(404);

    const list = await api().get('/v1/locations').set(h).expect(200);
    expect(list.body.map((l: { id: string }) => l.id)).toEqual([fx.locationId]);
    const registers = await api().get('/v1/registers').set(h).expect(200);
    expect(registers.body.map((r: { id: string }) => r.id)).toEqual([fx.registerId]);

    const all = await api()
      .get('/v1/locations')
      .set('Authorization', `Bearer ${owner}`)
      .expect(200);
    expect(all.body).toHaveLength(2);
  });

  it('GET location sets ETag and PATCH requires a matching If-Match (412 when stale)', async () => {
    const h = { Authorization: `Bearer ${owner}` };
    const before = await api().get(`/v1/locations/${fx.locationId}`).set(h).expect(200);
    expect(before.headers.etag).toBe('"1"');
    await api()
      .patch(`/v1/locations/${fx.locationId}`)
      .set(h)
      .send({ name: 'Sydney Central' })
      .expect(428);
    const ok = await api()
      .patch(`/v1/locations/${fx.locationId}`)
      .set(h)
      .set('If-Match', '"1"')
      .send({ name: 'Sydney Central' })
      .expect(200);
    expect(ok.body).toMatchObject({ name: 'Sydney Central', version: 2 });
    expect(ok.headers.etag).toBe('"2"');
    await api()
      .patch(`/v1/locations/${fx.locationId}`)
      .set(h)
      .set('If-Match', '"1"')
      .send({ name: 'Stale' })
      .expect(412);
    await api()
      .patch(`/v1/locations/${fx.locationId}`)
      .set(h)
      .set('If-Match', '"2"')
      .send({ currency: 'nope' })
      .expect(422);
  });

  it('config resolution returns the nearest override (acceptance) and keeps history', async () => {
    const h = { Authorization: `Bearer ${owner}` };
    await api()
      .put('/v1/config')
      .set(h)
      .set(idem())
      .send({
        key: 'receipt.header',
        scopeKind: 'tenant',
        scopeId: fx.tenantId,
        value: 'Tenant header',
      })
      .expect(200);
    await api()
      .put('/v1/config')
      .set(h)
      .set(idem())
      .send({
        key: 'receipt.header',
        scopeKind: 'location',
        scopeId: fx.locationId,
        value: 'Sydney header',
        reason: 'local promo',
      })
      .expect(200);

    const atRegister = await api()
      .get('/v1/config')
      .set(h)
      .query({ key: 'receipt.header', scopeKind: 'register', scopeId: fx.registerId })
      .expect(200);
    expect(atRegister.body).toEqual({
      key: 'receipt.header',
      value: 'Sydney header',
      resolvedScope: { kind: 'location', id: fx.locationId },
      version: 1,
    });

    const atOther = await api()
      .get('/v1/config')
      .set(h)
      .query({ key: 'receipt.header', scopeKind: 'location', scopeId: fx.otherLocationId })
      .expect(200);
    expect(atOther.body).toMatchObject({
      value: 'Tenant header',
      resolvedScope: { kind: 'tenant', id: fx.tenantId },
    });

    const unset = await api()
      .get('/v1/config')
      .set(h)
      .query({ key: 'cash.rounding.enabled', scopeKind: 'register', scopeId: fx.registerId })
      .expect(200);
    expect(unset.body).toEqual({
      key: 'cash.rounding.enabled',
      value: true,
      resolvedScope: 'default',
      version: null,
    });

    await api()
      .put('/v1/config')
      .set(h)
      .set(idem())
      .send({
        key: 'receipt.header',
        scopeKind: 'location',
        scopeId: fx.locationId,
        value: 'Sydney header v2',
      })
      .expect(200);
    const history = await api()
      .get('/v1/config/history')
      .set(h)
      .query({ key: 'receipt.header', scopeKind: 'location', scopeId: fx.locationId })
      .expect(200);
    expect(
      history.body.map((e: { version: number; isCurrent: boolean }) => [e.version, e.isCurrent]),
    ).toEqual([
      [2, true],
      [1, false],
    ]);

    await api()
      .put('/v1/config')
      .set(h)
      .set(idem())
      .send({ key: 'receipt.header', scopeKind: 'location', scopeId: fx.locationId, value: 42 })
      .expect(422);
    await api()
      .put('/v1/config')
      .set(h)
      .set(idem())
      .send({
        key: 'identity.pin.max_attempts',
        scopeKind: 'register',
        scopeId: fx.registerId,
        value: 3,
      })
      .expect(422);
    await api()
      .put('/v1/config')
      .set(h)
      .set(idem())
      .send({ key: 'no.such.key', scopeKind: 'tenant', scopeId: fx.tenantId, value: 1 })
      .expect(422);
    // the location manager may read config at their location but not at the tenant
    await api()
      .get('/v1/config')
      .set('Authorization', `Bearer ${locationAManager}`)
      .query({ key: 'receipt.header', scopeKind: 'location', scopeId: fx.locationId })
      .expect(200);
    await api()
      .get('/v1/config')
      .set('Authorization', `Bearer ${locationAManager}`)
      .query({ key: 'receipt.header', scopeKind: 'tenant', scopeId: fx.tenantId })
      .expect(404);
  });

  it('reparent bumps the version, rewrites the closure, and rejects stale If-Match and cycles', async () => {
    const h = { Authorization: `Bearer ${owner}` };
    const created = await api()
      .post('/v1/org-units')
      .set(h)
      .set(idem())
      .send({ parentId: fx.childOrgUnitId, kind: 'division', code: 'div-1', name: 'Division 1' })
      .expect(201);
    const id = created.body.id as string;
    expect(created.body.version).toBe(1);

    await api()
      .post(`/v1/org-units/${id}/reparent`)
      .set(h)
      .set(idem())
      .set('If-Match', '"7"')
      .send({ parentId: fx.rootOrgUnitId })
      .expect(412);
    const moved = await api()
      .post(`/v1/org-units/${id}/reparent`)
      .set(h)
      .set(idem())
      .set('If-Match', '"1"')
      .send({ parentId: fx.rootOrgUnitId })
      .expect(200);
    expect(moved.body).toMatchObject({ parentId: fx.rootOrgUnitId, version: 2 });
    const paths = await db.admin.query<{ ancestor_id: string; depth: number }>(
      'SELECT ancestor_id, depth FROM tenancy.org_unit_paths WHERE descendant_id = $1 ORDER BY depth',
      [id],
    );
    expect(paths.rows).toEqual([
      { ancestor_id: id, depth: 0 },
      { ancestor_id: fx.rootOrgUnitId, depth: 1 },
    ]);

    const cycle = await api()
      .post(`/v1/org-units/${fx.rootOrgUnitId}/reparent`)
      .set(h)
      .set(idem())
      .set('If-Match', '"1"')
      .send({ parentId: id })
      .expect(422);
    expect(cycle.body.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(cycle.body)).not.toContain('org_unit_paths');
    await api()
      .post(`/v1/org-units/${id}/reparent`)
      .set(h)
      .set(idem())
      .set('If-Match', '"2"')
      .send({ parentId: fx.locationId })
      .expect(404);
  });

  it('idempotent POST replays the stored response and rejects a reused key with a different body', async () => {
    const h = { Authorization: `Bearer ${owner}` };
    const key = randomUUID();
    const body = {
      orgUnitId: fx.rootOrgUnitId,
      code: 'bne-1',
      name: 'Brisbane',
      kind: 'store',
      timezone: 'Australia/Brisbane',
      currency: 'AUD',
    };
    await api().post('/v1/locations').set(h).send(body).expect(400);
    const first = await api()
      .post('/v1/locations')
      .set(h)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const replay = await api()
      .post('/v1/locations')
      .set(h)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    await api()
      .post('/v1/locations')
      .set(h)
      .set('Idempotency-Key', key)
      .send({ ...body, code: 'bne-2' })
      .expect(422);
    const count = await db.admin.query(
      "SELECT count(*)::int AS n FROM tenancy.locations WHERE code LIKE 'bne-%'",
    );
    expect(count.rows[0].n).toBe(1);
    // the create was audited and emitted in the same transaction
    const audit = await db.admin.query(
      'SELECT action FROM audit.audit_log WHERE tenant_id = $1 AND resource_id = $2',
      [fx.tenantId, first.body.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['tenancy.location.created']);
    const outbox = await db.admin.query(
      'SELECT event_type FROM audit.outbox_events WHERE tenant_id = $1 AND aggregate_id = $2',
      [fx.tenantId, first.body.id],
    );
    expect(outbox.rows.map((r) => r.event_type)).toEqual(['location.created']);
  });

  it('business days: one open day per location, close is audited', async () => {
    const h = { Authorization: `Bearer ${owner}` };
    const opened = await api()
      .post(`/v1/locations/${fx.otherLocationId}/business-days/open`)
      .set(h)
      .set(idem())
      .send({ businessDate: '2020-01-01' })
      .expect(201);
    expect(opened.body).toMatchObject({ businessDate: '2020-01-01', status: 'open' });
    await api()
      .post(`/v1/locations/${fx.otherLocationId}/business-days/open`)
      .set(h)
      .set(idem())
      .send({})
      .expect(409);
    const closed = await api()
      .post(`/v1/locations/${fx.otherLocationId}/business-days/close`)
      .set(h)
      .set(idem())
      .send({ businessDate: '2020-01-01' })
      .expect(200);
    expect(closed.body.status).toBe('closed');
    // a closed day cannot be reopened
    await api()
      .post(`/v1/locations/${fx.otherLocationId}/business-days/open`)
      .set(h)
      .set(idem())
      .send({ businessDate: '2020-01-01' })
      .expect(409);
    const auto = await api()
      .post(`/v1/locations/${fx.otherLocationId}/business-days/open`)
      .set(h)
      .set(idem())
      .send({})
      .expect(201);
    expect(auto.body.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('operators provision a tenant atomically: tenant, root org unit, first admin, audit row and outbox event', async () => {
    const res = await api()
      .post('/v1/tenants')
      .set('Authorization', `Bearer ${operator}`)
      .set(idem())
      .send({
        slug: 'new-cafe',
        name: 'New Cafe',
        admin: { email: 'owner@new-cafe.test', displayName: 'Owner' },
      })
      .expect(201);
    const tenantId = res.body.tenant.id as string;
    expect(res.body.tenant).toMatchObject({ slug: 'new-cafe', status: 'active' });
    expect(res.body.admin.inviteToken).toBe('stub-invite-token');
    const root = await db.admin.query('SELECT code FROM tenancy.org_units WHERE tenant_id = $1', [
      tenantId,
    ]);
    expect(root.rows).toEqual([{ code: 'root' }]);
    const audit = await db.admin.query(
      'SELECT action, actor_kind FROM audit.audit_log WHERE tenant_id = $1',
      [tenantId],
    );
    expect(audit.rows).toEqual([{ action: 'platform.tenant.provisioned', actor_kind: 'operator' }]);
    const events = await db.admin.query(
      'SELECT event_type FROM audit.outbox_events WHERE tenant_id = $1',
      [tenantId],
    );
    expect(events.rows).toEqual([{ event_type: 'tenant.provisioned' }]);
    // tenant users cannot provision, a duplicate slug conflicts
    await api()
      .post('/v1/tenants')
      .set('Authorization', `Bearer ${owner}`)
      .set(idem())
      .send({ slug: 'x-cafe', name: 'X', admin: { email: 'a@b.test', displayName: 'A' } })
      .expect(404);
    await api()
      .post('/v1/tenants')
      .set('Authorization', `Bearer ${operator}`)
      .set(idem())
      .send({ slug: 'new-cafe', name: 'Dup', admin: { email: 'a@b.test', displayName: 'A' } })
      .expect(409);
  });
});
