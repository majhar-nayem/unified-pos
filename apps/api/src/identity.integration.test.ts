import { generateKeyPairSync, sign } from 'node:crypto';
import { randomUUID } from 'node:crypto';

import {
  startPostgresWithSchema,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '@pos/testing';
import { URI as OtpUri } from 'otpauth';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SoftwareAuthenticator } from './testing/software-authenticator.js';
import { createTestApp, type TestApp } from './testing/test-app.js';

const OPERATOR_TOKEN = 'op_integration_operator_token_0001';
const PASSWORD = 'correct horse battery staple';

describe('identity module end to end (real JWT authentication)', () => {
  let db: TestPostgres;
  let redis: TestRedis;
  let t: TestApp;
  const api = () => supertest(t.server);
  const idem = () => ({ 'Idempotency-Key': randomUUID() });
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  // state shared across the ordered steps below
  let tenantId: string;
  let rootOrgUnitId: string;
  let ownerToken: string;
  let locationA: string;
  let locationB: string;
  let registerA: string;
  const roles: Record<string, string> = {};
  const users: Record<string, { id: string; email: string; token?: string; refresh?: string }> = {};

  beforeAll(async () => {
    process.env.AUTH_OPERATOR_TOKENS = `${randomUUID()}:${OPERATOR_TOKEN}`;
    [db, redis] = await Promise.all([startPostgresWithSchema(), startRedis()]);
    t = await createTestApp({ databaseUrl: db.appUrl, redisUrl: redis.url, authenticator: 'jwt' });
  });

  afterAll(async () => {
    await t?.close();
    await db?.stop();
    await redis?.stop();
  });

  function login(tenantSlug: string, email: string, password: string) {
    return api().post('/v1/auth/login').send({ tenantSlug, email, password });
  }

  async function createUser(name: string, email: string, password = PASSWORD) {
    const res = await api()
      .post('/v1/users')
      .set(bearer(ownerToken))
      .set(idem())
      .send({ email, displayName: name, password })
      .expect(201);
    const loginRes = await login('acme', email, password).expect(200);
    expect(loginRes.body.status).toBe('authenticated');
    users[name] = {
      id: res.body.id,
      email,
      token: loginRes.body.tokens.accessToken,
      refresh: loginRes.body.tokens.refreshToken,
    };
    return users[name]!;
  }

  async function grant(
    userId: string,
    roleKey: string,
    scope: { kind: string; id: string },
    extra: Record<string, unknown> = {},
  ) {
    const res = await api()
      .post('/v1/role-assignments')
      .set(bearer(ownerToken))
      .set(idem())
      .send({ userId, roleId: roles[roleKey], scope, ...extra })
      .expect(201);
    return res.body as { id: string };
  }

  it('provisions a tenant with an operator token; the invited owner accepts and must enrol MFA (tenant_owner holds *.admin)', async () => {
    const provisioned = await api()
      .post('/v1/tenants')
      .set(bearer(OPERATOR_TOKEN))
      .set(idem())
      .send({
        slug: 'acme',
        name: 'Acme',
        admin: { email: 'owner@acme.test', displayName: 'Acme Owner' },
      })
      .expect(201);
    tenantId = provisioned.body.tenant.id;
    rootOrgUnitId = provisioned.body.rootOrgUnitId;
    expect(provisioned.body.admin.inviteToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    await api()
      .post('/v1/tenants')
      .set(bearer('op_not_a_real_token_00000'))
      .set(idem())
      .send({ slug: 'x', name: 'x', admin: { email: 'a@b.test', displayName: 'a' } })
      .expect(401);

    await login('acme', 'owner@acme.test', PASSWORD).expect(401); // invited, no password yet
    const accepted = await api()
      .post('/v1/users/accept-invite')
      .send({ token: provisioned.body.admin.inviteToken, password: PASSWORD })
      .expect(200);
    expect(accepted.body).toEqual({ tenantId, userId: provisioned.body.admin.userId });
    await api()
      .post('/v1/users/accept-invite')
      .send({ token: provisioned.body.admin.inviteToken, password: PASSWORD })
      .expect(422);

    const first = await login('acme', 'owner@acme.test', PASSWORD).expect(200);
    expect(first.body.status).toBe('mfa_enrollment_required');
    const preauth = first.body.preauthToken as string;
    await api().get('/v1/locations').set(bearer(preauth)).expect(401); // preauth cannot call normal routes

    const enrol = await api().post('/v1/users/me/totp/enroll').set(bearer(preauth)).expect(200);
    const totp = OtpUri.parse(enrol.body.otpauthUri);
    await api()
      .post('/v1/users/me/totp/confirm')
      .set(bearer(preauth))
      .send({ code: '000000' })
      .expect(422);
    await api()
      .post('/v1/users/me/totp/confirm')
      .set(bearer(preauth))
      .send({ code: totp.generate() })
      .expect(204);

    const second = await login('acme', 'owner@acme.test', PASSWORD).expect(200);
    expect(second.body).toMatchObject({ status: 'mfa_required', methods: ['totp'] });
    const verified = await api()
      .post('/v1/auth/mfa/totp')
      .set(bearer(second.body.preauthToken))
      .send({ code: totp.generate() })
      .expect(200);
    expect(verified.body.status).toBe('authenticated');
    ownerToken = verified.body.tokens.accessToken;
    await api()
      .post('/v1/auth/mfa/totp')
      .set(bearer(second.body.preauthToken))
      .send({ code: totp.generate() })
      .expect(401); // replay of the same step

    const me = await api().get('/v1/auth/me').set(bearer(ownerToken)).expect(200);
    expect(me.body).toMatchObject({ kind: 'user', mfaVerified: true, mfaRequired: true });
    expect(me.body.permissions).toContain('tenancy.admin');
    expect(me.body.assignments[0]).toMatchObject({
      role: 'tenant_owner',
      scope: { kind: 'tenant', id: tenantId },
    });
    const events = await db.admin.query<{ outcome: string }>(
      'SELECT outcome FROM identity.login_events WHERE tenant_id = $1 ORDER BY occurred_at',
      [tenantId],
    );
    expect(events.rows.map((r) => r.outcome)).toEqual([
      'bad_credentials',
      'mfa_required',
      'mfa_required',
      'success',
      'mfa_failed',
    ]);
  });

  it('system roles are seeded and immutable; cloning yields an editable tenant role', async () => {
    const list = await api().get('/v1/roles').set(bearer(ownerToken)).expect(200);
    for (const role of list.body as Array<{
      key: string;
      id: string;
      isSystem: boolean;
      limits: Record<string, unknown>;
    }>)
      roles[role.key] = role.id;
    expect(Object.keys(roles)).toEqual(
      expect.arrayContaining(['tenant_owner', 'store_manager', 'cashier', 'shift_supervisor']),
    );
    const cashier = (list.body as Array<{ key: string; limits: Record<string, unknown> }>).find(
      (r) => r.key === 'cashier',
    )!;
    expect(cashier.limits).toEqual({ 'orders.discount.max_percent': 10 });

    const forbidden = await api()
      .put(`/v1/roles/${roles.cashier}/permissions`)
      .set(bearer(ownerToken))
      .send({ permissions: ['orders.void'] })
      .expect(403);
    expect(forbidden.body.error.code).toBe('SYSTEM_ROLE_IMMUTABLE');
    const clone = await api()
      .post(`/v1/roles/${roles.cashier}/clone`)
      .set(bearer(ownerToken))
      .set(idem())
      .send({ key: 'cashier_plus', name: 'Cashier plus' })
      .expect(201);
    expect(clone.body).toMatchObject({
      isSystem: false,
      permissions: [
        'approvals.request',
        'orders.create',
        'orders.discount.apply',
        'orders.view',
        'payments.intent.create',
        'payments.view',
      ],
      limits: { 'orders.discount.max_percent': 10 },
    });
    const edited = await api()
      .put(`/v1/roles/${clone.body.id}/permissions`)
      .set(bearer(ownerToken))
      .send({ permissions: ['orders.discount.apply', 'orders.void'] })
      .expect(200);
    expect(edited.body.permissions).toEqual(['orders.discount.apply', 'orders.void']);
    await api()
      .put(`/v1/roles/${clone.body.id}/permissions`)
      .set(bearer(ownerToken))
      .send({ permissions: ['nope.nothing'] })
      .expect(422);
    roles.cashier_plus = clone.body.id;
  });

  it('F1 acceptance with real tokens: a grant at Location A opens A (200) but not B (404); revoking closes it; expired elevation is 403', async () => {
    const locA = await api()
      .post('/v1/locations')
      .set(bearer(ownerToken))
      .set(idem())
      .send({
        orgUnitId: rootOrgUnitId,
        code: 'syd',
        name: 'Sydney',
        kind: 'store',
        timezone: 'Australia/Sydney',
        currency: 'AUD',
      })
      .expect(201);
    const locB = await api()
      .post('/v1/locations')
      .set(bearer(ownerToken))
      .set(idem())
      .send({
        orgUnitId: rootOrgUnitId,
        code: 'mel',
        name: 'Melbourne',
        kind: 'store',
        timezone: 'Australia/Melbourne',
        currency: 'AUD',
      })
      .expect(201);
    locationA = locA.body.id;
    locationB = locB.body.id;
    const reg = await api()
      .post(`/v1/locations/${locationA}/registers`)
      .set(bearer(ownerToken))
      .set(idem())
      .send({ code: 'R1', name: 'Register 1' })
      .expect(201);
    registerA = reg.body.id;

    const mgr = await createUser('manager', 'manager@acme.test');
    await api().get(`/v1/locations/${locationA}`).set(bearer(mgr.token!)).expect(404); // no assignments yet
    const assignment = await grant(
      mgr.id,
      'store_manager',
      { kind: 'location', id: locationA },
      { reason: 'runs Sydney' },
    );
    await api().get(`/v1/locations/${locationA}`).set(bearer(mgr.token!)).expect(200); // same token: stale av → principal rebuilt
    await api().get(`/v1/locations/${locationB}`).set(bearer(mgr.token!)).expect(404);
    await api().get(`/v1/registers/${registerA}`).set(bearer(mgr.token!)).expect(200);
    const me = await api().get('/v1/auth/me').set(bearer(mgr.token!)).expect(200);
    expect(me.body.assignments[0]).toMatchObject({
      role: 'store_manager',
      limits: { 'orders.discount.max_percent': 30, 'orders.refund.max_minor': 50000 },
    });

    const mine = await api()
      .get('/v1/role-assignments')
      .set(bearer(ownerToken))
      .query({ userId: mgr.id })
      .expect(200);
    expect(mine.body.map((a: { id: string }) => a.id)).toEqual([assignment.id]);
    await api()
      .delete(`/v1/role-assignments/${assignment.id}`)
      .set(bearer(ownerToken))
      .send({ reason: 'moved' })
      .expect(204);
    await api().get(`/v1/locations/${locationA}`).set(bearer(mgr.token!)).expect(404);

    await grant(
      mgr.id,
      'store_manager',
      { kind: 'location', id: locationA },
      {
        validFrom: '2020-01-01T00:00:00Z',
        validTo: '2020-01-02T00:00:00Z',
        reason: 'past elevation',
      },
    );
    const expired = await api()
      .get(`/v1/locations/${locationA}`)
      .set(bearer(mgr.token!))
      .expect(403);
    expect(expired.body.error.code).toBe('ASSIGNMENT_EXPIRED');

    // assignment-level limit overrides the role-level limit
    const limited = await grant(
      mgr.id,
      'cashier',
      { kind: 'location', id: locationB },
      { limits: { 'orders.discount.max_percent': 5 } },
    );
    const me2 = await api().get('/v1/auth/me').set(bearer(mgr.token!)).expect(200);
    expect(
      me2.body.assignments.find((a: { assignmentId: string }) => a.assignmentId === limited.id)
        .limits,
    ).toEqual({ 'orders.discount.max_percent': 5 });
    const audit = await db.admin.query<{ action: string }>(
      "SELECT action FROM audit.audit_log WHERE tenant_id = $1 AND action LIKE 'access.assignment.%' ORDER BY seq",
      [tenantId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'access.assignment.granted',
      'access.assignment.granted',
      'access.assignment.revoked',
      'access.assignment.granted',
      'access.assignment.granted',
    ]);
  });

  it('login lockout after five bad passwords, refresh rotation with reuse detection, logout', async () => {
    const u = await createUser('locky', 'locky@acme.test');
    for (let i = 0; i < 4; i++) await login('acme', u.email, 'wrong password!!').expect(401);
    const locked = await login('acme', u.email, 'wrong password!!').expect(423);
    expect(locked.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    await login('acme', u.email, PASSWORD).expect(423);
    await login('nope', u.email, PASSWORD).expect(401);
    await login('acme', 'ghost@acme.test', PASSWORD).expect(401);

    const rotated = await api()
      .post('/v1/auth/refresh')
      .send({ refreshToken: u.refresh })
      .expect(200);
    expect(rotated.body.refreshToken).not.toBe(u.refresh);
    const reuse = await api()
      .post('/v1/auth/refresh')
      .send({ refreshToken: u.refresh })
      .expect(401);
    expect(reuse.body.error.code).toBe('REFRESH_REUSED');
    const revoked = await api()
      .get('/v1/auth/me')
      .set(bearer(rotated.body.accessToken))
      .expect(401);
    expect(revoked.body.error.code).toBe('SESSION_REVOKED');
    await api()
      .post('/v1/auth/refresh')
      .send({ refreshToken: rotated.body.refreshToken })
      .expect(401);

    const fresh = await createUser('bye', 'bye@acme.test');
    await api().get('/v1/auth/me').set(bearer(fresh.token!)).expect(200);
    await api().post('/v1/auth/logout').set(bearer(fresh.token!)).expect(204);
    await api().get('/v1/auth/me').set(bearer(fresh.token!)).expect(401);
    await api().post('/v1/auth/refresh').send({ refreshToken: fresh.refresh }).expect(401);
  });

  it('device enrolment with an Ed25519 key, signed-challenge login, PIN sign-in with lockout, and revocation', async () => {
    const staff = await createUser('staff', 'staff@acme.test');
    await grant(staff.id, 'cashier', { kind: 'location', id: locationA });
    await api()
      .put(`/v1/users/${staff.id}/pin`)
      .set(bearer(ownerToken))
      .set(idem())
      .send({ locationId: locationA, pin: '2468' })
      .expect(204);
    await api()
      .put(`/v1/users/${staff.id}/pin`)
      .set(bearer(ownerToken))
      .set(idem())
      .send({ locationId: locationA, pin: '1357' })
      .expect(204); // replaces
    const pins = await db.admin.query<{ status: string }>(
      "SELECT status FROM identity.user_credentials WHERE user_id = $1 AND kind = 'pos_pin' ORDER BY created_at",
      [staff.id],
    );
    expect(pins.rows.map((r) => r.status)).toEqual(['revoked', 'active']);

    const code = await api()
      .post('/v1/devices/enrollment-codes')
      .set(bearer(ownerToken))
      .set(idem())
      .send({ locationId: locationA, registerId: registerA, kind: 'pos' })
      .expect(201);
    expect(code.body.code).toMatch(/^acme\.[0-9A-Z]{12}$/);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    const enrolled = await api()
      .post('/v1/auth/device/enroll')
      .send({
        enrollmentCode: code.body.code,
        publicKey: spki.toString('base64'),
        name: 'Counter 1',
        platform: 'android',
        appVersion: '1.0.0',
      })
      .expect(201);
    const deviceId = enrolled.body.device.id as string;
    expect(enrolled.body.device).toMatchObject({
      enrollmentStatus: 'enrolled',
      locationId: locationA,
      registerId: registerA,
    });
    await api()
      .post('/v1/auth/device/enroll')
      .send({
        enrollmentCode: code.body.code,
        publicKey: spki.toString('base64'),
        name: 'Again',
        platform: 'android',
        appVersion: '1.0.0',
      })
      .expect(404); // single use
    const deviceToken = enrolled.body.tokens.accessToken as string;
    const deviceMe = await api().get('/v1/auth/me').set(bearer(deviceToken)).expect(200);
    expect(deviceMe.body).toMatchObject({ kind: 'device', deviceId, locationId: locationA });
    expect(deviceMe.body.assignments[0].coveredScopeIds).toContain(registerA);

    const challenge = await api()
      .get('/v1/auth/device/challenge')
      .query({ tenantId, deviceId })
      .expect(200);
    const message = Buffer.from(`${challenge.body.nonce}.${deviceId}.${tenantId}`, 'utf8');
    const signature = sign(null, message, privateKey).toString('base64');
    await api()
      .post('/v1/auth/device/login')
      .send({
        tenantId,
        deviceId,
        nonce: challenge.body.nonce,
        signature: Buffer.from('bad').toString('base64'),
      })
      .expect(401);
    const challenge2 = await api()
      .get('/v1/auth/device/challenge')
      .query({ tenantId, deviceId })
      .expect(200);
    const signature2 = sign(
      null,
      Buffer.from(`${challenge2.body.nonce}.${deviceId}.${tenantId}`, 'utf8'),
      privateKey,
    ).toString('base64');
    const loggedIn = await api()
      .post('/v1/auth/device/login')
      .send({ tenantId, deviceId, nonce: challenge2.body.nonce, signature: signature2 })
      .expect(200);
    expect(loggedIn.body.accessToken).toBeTruthy();
    void signature;

    await api()
      .post('/v1/auth/pin')
      .set(bearer(ownerToken))
      .send({ userId: staff.id, pin: '1357' })
      .expect(401); // needs a device token
    await api()
      .post('/v1/auth/pin')
      .set(bearer(deviceToken))
      .send({ userId: staff.id, pin: '2468' })
      .expect(401); // old pin
    const pos = await api()
      .post('/v1/auth/pin')
      .set(bearer(deviceToken))
      .send({ userId: staff.id, pin: '1357' })
      .expect(200);
    const posMe = await api().get('/v1/auth/me').set(bearer(pos.body.accessToken)).expect(200);
    expect(posMe.body).toMatchObject({
      kind: 'user',
      subjectId: staff.id,
      deviceId,
      locationId: locationA,
    });
    users.staff!.token = pos.body.accessToken;

    const other = await createUser('other', 'other@acme.test');
    await api()
      .put(`/v1/users/${other.id}/pin`)
      .set(bearer(ownerToken))
      .set(idem())
      .send({ locationId: locationA, pin: '9999' })
      .expect(204);
    for (let i = 0; i < 4; i++)
      await api()
        .post('/v1/auth/pin')
        .set(bearer(deviceToken))
        .send({ userId: other.id, pin: '0000' })
        .expect(401);
    await api()
      .post('/v1/auth/pin')
      .set(bearer(deviceToken))
      .send({ userId: other.id, pin: '0000' })
      .expect(423);
    await api()
      .post('/v1/auth/pin')
      .set(bearer(deviceToken))
      .send({ userId: other.id, pin: '9999' })
      .expect(423);
    const lockAudit = await db.admin.query(
      "SELECT 1 FROM audit.audit_log WHERE tenant_id = $1 AND action = 'identity.pin.locked'",
      [tenantId],
    );
    expect(lockAudit.rows).toHaveLength(1);

    await api()
      .post(`/v1/devices/${deviceId}/revoke`)
      .set(bearer(ownerToken))
      .set(idem())
      .send({ reason: 'lost' })
      .expect(201);
    const gone = await api().get('/v1/auth/me').set(bearer(deviceToken)).expect(401);
    expect(gone.body.error.code).toBe('DEVICE_REVOKED');
    await api().get('/v1/auth/me').set(bearer(pos.body.accessToken)).expect(401); // pos session bound to the device is revoked too
  });

  it('client credentials issue an API token carrying the client scopes; revocation ends it', async () => {
    const created = await api()
      .post('/v1/api-clients')
      .set(bearer(ownerToken))
      .set(idem())
      .send({ name: 'Integration', scopes: ['tenancy.location.view'] })
      .expect(201);
    const { clientId } = created.body.client;
    const secret = created.body.clientSecret as string;
    await api()
      .post('/v1/auth/client')
      .send({ tenantSlug: 'acme', clientId, clientSecret: 'wrong' })
      .expect(401);
    const token = await api()
      .post('/v1/auth/client')
      .send({ tenantSlug: 'acme', clientId, clientSecret: secret })
      .expect(200);
    const me = await api().get('/v1/auth/me').set(bearer(token.body.accessToken)).expect(200);
    expect(me.body).toMatchObject({ kind: 'api_client', permissions: ['tenancy.location.view'] });
    const locations = await api()
      .get('/v1/locations')
      .set(bearer(token.body.accessToken))
      .expect(200);
    expect(locations.body).toHaveLength(2);
    await api().get('/v1/users').set(bearer(token.body.accessToken)).expect(403);
    await api()
      .post(`/v1/api-clients/${created.body.client.id}/revoke`)
      .set(bearer(ownerToken))
      .set(idem())
      .expect(200);
    await api()
      .post('/v1/auth/client')
      .send({ tenantSlug: 'acme', clientId, clientSecret: secret })
      .expect(401);
    const gone = await api().get('/v1/auth/me').set(bearer(token.body.accessToken)).expect(401);
    expect(gone.body.error.code).toBe('CLIENT_REVOKED');
  });

  it('approvals: over-limit discount → request; a supervisor under the limit cannot approve, a manager with PIN can; consumption checks the hash', async () => {
    // cashier at location A: the device-bound session was revoked with the device, so sign in again
    const staffLogin = await login('acme', 'staff@acme.test', PASSWORD).expect(200);
    const cashier = { ...users.staff!, token: staffLogin.body.tokens.accessToken as string };
    const manager = await createUser('mgr2', 'mgr2@acme.test');
    await grant(manager.id, 'store_manager', { kind: 'location', id: locationA });
    await api()
      .put(`/v1/users/${manager.id}/pin`)
      .set(bearer(ownerToken))
      .set(idem())
      .send({ locationId: locationA, pin: '4321' })
      .expect(204);
    const supervisor = await createUser('sup', 'sup@acme.test');
    await grant(supervisor.id, 'shift_supervisor', { kind: 'location', id: locationA });
    await api()
      .put(`/v1/users/${supervisor.id}/pin`)
      .set(bearer(ownerToken))
      .set(idem())
      .send({ locationId: locationA, pin: '1111' })
      .expect(204);

    const payload = {
      permission: 'orders.discount.apply',
      attributes: { 'orders.discount.max_percent': 25 },
      orderLineId: randomUUID(),
    };
    const request = await api()
      .post('/v1/approvals')
      .set(bearer(cashier.token!))
      .set(idem())
      .send({
        kind: 'discount_over_limit',
        locationId: locationA,
        subjectKind: 'order_line',
        payload,
      })
      .expect(201);
    const approvalId = request.body.id as string;
    expect(request.body).toMatchObject({ status: 'pending', requestedBy: cashier.id });

    // nobody may self-approve, and a factor is required on a non-MFA session
    const selfie = await api()
      .post(`/v1/approvals/${approvalId}/approve`)
      .set(bearer(cashier.token!))
      .set(idem())
      .send({})
      .expect(403);
    expect(selfie.body.error.code).toBe('APPROVER_FACTOR_REQUIRED');
    const tooLow = await api()
      .post(`/v1/approvals/${approvalId}/approve`)
      .set(bearer(cashier.token!))
      .set(idem())
      .send({ factor: { kind: 'pin', userId: supervisor.id, pin: '1111' } })
      .expect(403);
    expect(tooLow.body.error.code).toBe('APPROVER_NOT_PERMITTED');
    const badPin = await api()
      .post(`/v1/approvals/${approvalId}/approve`)
      .set(bearer(cashier.token!))
      .set(idem())
      .send({ factor: { kind: 'pin', userId: manager.id, pin: '0000' } })
      .expect(403);
    expect(badPin.body.error.code).toBe('APPROVER_PIN_INVALID');
    const approved = await api()
      .post(`/v1/approvals/${approvalId}/approve`)
      .set(bearer(cashier.token!))
      .set(idem())
      .send({ factor: { kind: 'pin', userId: manager.id, pin: '4321' }, note: 'regular' })
      .expect(200);
    expect(approved.body).toMatchObject({ status: 'approved', decidedBy: manager.id });
    await api()
      .post(`/v1/approvals/${approvalId}/approve`)
      .set(bearer(cashier.token!))
      .set(idem())
      .send({ factor: { kind: 'pin', userId: manager.id, pin: '4321' } })
      .expect(409);

    const mismatch = await api()
      .post(`/v1/approvals/${approvalId}/consume`)
      .set(bearer(cashier.token!))
      .set(idem())
      .send({ payloadHash: 'f'.repeat(64) })
      .expect(409);
    expect(mismatch.body.error.code).toBe('APPROVAL_PAYLOAD_MISMATCH');
    const consumed = await api()
      .post(`/v1/approvals/${approvalId}/consume`)
      .set(bearer(cashier.token!))
      .set(idem())
      .send({ payloadHash: request.body.payloadHash })
      .expect(200);
    expect(consumed.body.status).toBe('consumed');
    const onBehalf = await db.admin.query<{ on_behalf_of: string }>(
      "SELECT on_behalf_of FROM audit.audit_log WHERE tenant_id = $1 AND action = 'approvals.consumed'",
      [tenantId],
    );
    expect(onBehalf.rows[0]!.on_behalf_of).toBe(manager.id);

    // expiry is applied lazily
    const stale = await api()
      .post('/v1/approvals')
      .set(bearer(cashier.token!))
      .set(idem())
      .send({
        kind: 'refund_over_limit',
        locationId: locationA,
        subjectKind: 'order',
        payload: {
          permission: 'orders.refund.create',
          attributes: { 'orders.refund.max_minor': 1000 },
        },
      })
      .expect(201);
    await db.admin.query(
      "UPDATE identity.approval_requests SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [stale.body.id],
    );
    const expired = await api()
      .post(`/v1/approvals/${stale.body.id}/approve`)
      .set(bearer(cashier.token!))
      .set(idem())
      .send({ factor: { kind: 'pin', userId: manager.id, pin: '4321' } })
      .expect(409);
    expect(expired.body.error.code).toBe('APPROVAL_EXPIRED');
    const pending = await api()
      .get('/v1/approvals')
      .set(bearer(manager.token!))
      .query({ locationId: locationA })
      .expect(200);
    expect(pending.body).toEqual([]);
  });

  it('passkey full ceremony with a software authenticator: register, log in with mfa_required → passkey, counter advances, a stale sign count revokes the credential', async () => {
    const authenticator = new SoftwareAuthenticator({
      rpId: 'localhost',
      origin: 'http://localhost:3001',
    });

    // registration (attestation `none`) on the owner's MFA-verified web session
    const regOptions = await api()
      .post('/v1/users/me/passkeys/options')
      .set(bearer(ownerToken))
      .send({})
      .expect(200);
    expect(regOptions.body).toMatchObject({
      rp: { id: 'localhost' },
      challenge: expect.any(String),
      attestation: 'none',
    });
    await api()
      .post('/v1/users/me/passkeys')
      .set(bearer(ownerToken))
      .send({ response: { id: 'AAAA', rawId: 'AAAA', type: 'public-key', response: {} } })
      .expect(422);
    const consumed = await api()
      .post('/v1/users/me/passkeys')
      .set(bearer(ownerToken))
      .send({ label: 'MacBook Touch ID', response: authenticator.register(regOptions.body) })
      .expect(409); // a failed attempt consumes the challenge: options must be requested again
    expect(consumed.body.error.code).toBe('PASSKEY_CHALLENGE_MISSING');
    const regOptions2 = await api()
      .post('/v1/users/me/passkeys/options')
      .set(bearer(ownerToken))
      .send({})
      .expect(200);
    const registered = await api()
      .post('/v1/users/me/passkeys')
      .set(bearer(ownerToken))
      .send({ label: 'MacBook Touch ID', response: authenticator.register(regOptions2.body) })
      .expect(201);
    expect(registered.body.credentialId).toMatch(/^[0-9a-f-]{36}$/);
    const stored = await db.admin.query<{
      status: string;
      sign_count: bigint;
      transports: string[];
      label: string;
      credential_id: Buffer;
    }>(
      "SELECT status, sign_count, transports, label, credential_id FROM identity.user_credentials WHERE id = $1 AND kind = 'passkey'",
      [registered.body.credentialId],
    );
    expect(stored.rows[0]).toMatchObject({
      status: 'active',
      sign_count: 0n,
      transports: ['internal'],
      label: 'MacBook Touch ID',
    });
    expect(Buffer.from(stored.rows[0]!.credential_id).equals(authenticator.credentialId)).toBe(
      true,
    );

    // login → mfa_required now offers the passkey next to TOTP
    const first = await login('acme', 'owner@acme.test', PASSWORD).expect(200);
    expect(first.body).toMatchObject({ status: 'mfa_required', methods: ['totp', 'passkey'] });
    const preauth1 = first.body.preauthToken as string;
    const authOptions = await api()
      .post('/v1/auth/mfa/passkey/options')
      .set(bearer(preauth1))
      .send({})
      .expect(200);
    expect(authOptions.body).toMatchObject({
      rpId: 'localhost',
      allowCredentials: [{ id: authenticator.credentialIdBase64Url }],
    });
    const completed = await api()
      .post('/v1/auth/mfa/passkey/verify')
      .set(bearer(preauth1))
      .send({ response: authenticator.assert(authOptions.body) })
      .expect(200);
    expect(completed.body.status).toBe('authenticated');
    const me = await api()
      .get('/v1/auth/me')
      .set(bearer(completed.body.tokens.accessToken))
      .expect(200);
    expect(me.body).toMatchObject({ kind: 'user', mfaVerified: true });
    const replay = await api()
      .post('/v1/auth/mfa/passkey/verify')
      .set(bearer(preauth1))
      .send({ response: authenticator.assert(authOptions.body) })
      .expect(401);
    expect(replay.body.error.code).toBe('PASSKEY_CHALLENGE_MISSING');

    // a second genuine sign-in moves the stored counter on
    const second = await login('acme', 'owner@acme.test', PASSWORD).expect(200);
    const preauth2 = second.body.preauthToken as string;
    const authOptions2 = await api()
      .post('/v1/auth/mfa/passkey/options')
      .set(bearer(preauth2))
      .send({})
      .expect(200);
    await api()
      .post('/v1/auth/mfa/passkey/verify')
      .set(bearer(preauth2))
      .send({ response: authenticator.assert(authOptions2.body) })
      .expect(200);
    const counters = await db.admin.query<{ sign_count: bigint; last_used_at: Date | null }>(
      'SELECT sign_count, last_used_at FROM identity.user_credentials WHERE id = $1',
      [registered.body.credentialId],
    );
    // the rejected replay above still advanced the authenticator (1 → 2), as a real one would
    expect(authenticator.counter).toBe(3);
    expect(counters.rows[0]!.sign_count).toBe(3n);
    expect(counters.rows[0]!.last_used_at).toBeInstanceOf(Date);

    // a correctly signed assertion with a stale counter (a cloned key) revokes the credential
    const third = await login('acme', 'owner@acme.test', PASSWORD).expect(200);
    const preauth3 = third.body.preauthToken as string;
    const authOptions3 = await api()
      .post('/v1/auth/mfa/passkey/options')
      .set(bearer(preauth3))
      .send({})
      .expect(200);
    const cloned = await api()
      .post('/v1/auth/mfa/passkey/verify')
      .set(bearer(preauth3))
      .send({ response: authenticator.assert(authOptions3.body, { counter: 1 }) })
      .expect(401);
    expect(cloned.body.error.code).toBe('MFA_FAILED');
    const afterClone = await db.admin.query<{ status: string; sign_count: bigint }>(
      'SELECT status, sign_count FROM identity.user_credentials WHERE id = $1',
      [registered.body.credentialId],
    );
    expect(afterClone.rows[0]).toEqual({ status: 'revoked', sign_count: 3n });
    const noPasskey = await api()
      .post('/v1/auth/mfa/passkey/options')
      .set(bearer(preauth3))
      .send({})
      .expect(409);
    expect(noPasskey.body.error.code).toBe('PASSKEY_NOT_ENROLLED');
    const fourth = await login('acme', 'owner@acme.test', PASSWORD).expect(200);
    expect(fourth.body).toMatchObject({ status: 'mfa_required', methods: ['totp'] });
    const passkeyEvents = await db.admin.query<{ outcome: string }>(
      "SELECT outcome FROM identity.login_events WHERE tenant_id = $1 AND method = 'passkey' ORDER BY occurred_at",
      [tenantId],
    );
    expect(passkeyEvents.rows.map((r) => r.outcome)).toEqual(['success', 'success', 'mfa_failed']);
  });

  it('admin password reset revokes sessions and the old password stops working', async () => {
    const victim = await createUser('victim', 'victim@acme.test');
    await api().get('/v1/auth/me').set(bearer(victim.token!)).expect(200);
    await api()
      .put(`/v1/users/${victim.id}/password`)
      .set(bearer(ownerToken))
      .set(idem())
      .send({ newPassword: 'another password 456' })
      .expect(204);
    await api().get('/v1/auth/me').set(bearer(victim.token!)).expect(401);
    await login('acme', victim.email, PASSWORD).expect(401);
    await login('acme', victim.email, 'another password 456').expect(200);
    await api()
      .put('/v1/users/me/password')
      .set(bearer(ownerToken))
      .set(idem())
      .send({ currentPassword: 'wrong', newPassword: 'whatever password 1' })
      .expect(422);
  });
});
