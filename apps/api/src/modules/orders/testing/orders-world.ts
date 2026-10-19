import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Scope } from '@pos/auth';
import { PERMISSIONS } from '@pos/auth';
import {
  createHierarchyFixture,
  startPostgresWithSchema,
  startRedis,
  type HierarchyFixture,
  type TestPostgres,
  type TestRedis,
} from '@pos/testing';
import supertest from 'supertest';

// Integration tests compose the whole application, so this is the one import of the app shell in the module.
// eslint-disable-next-line boundaries/dependencies
import { createTestApp, userPrincipal, type TestApp } from '../../../testing/test-app.js';
import {
  type AuthenticationRequest,
  type Authenticator,
  KernelPorts,
  TestAuthenticator,
} from '../../kernel/public/index.js';

export const PASSWORD = 'correct horse battery staple';
const OPERATOR_TOKEN = 'op_orders_operator_token_0001';

export interface Actor {
  readonly id: string;
  readonly token: string;
}

export interface OrdersWorld {
  readonly db: TestPostgres;
  readonly redis: TestRedis;
  readonly t: TestApp;
  readonly objectStoreDir: string;
  readonly tenantId: string;
  readonly slug: string;
  readonly locationA: string;
  readonly locationB: string;
  readonly registerA: string;
  /** Test principal holding every permission at tenant scope (admin plumbing and "can do anything" cases). */
  readonly ownerToken: string;
  /** Real users with real JWTs: seeded system roles at location A (cashierB at location B). */
  readonly cashier: Actor;
  readonly supervisor: Actor;
  readonly manager: Actor;
  readonly managerPin: string;
  readonly supervisorPin: string;
  readonly cashierB: Actor;
  /** A second tenant with its own hierarchy and an all-permission principal, for isolation tests. */
  readonly foreign: HierarchyFixture & { token: string };
  readonly api: () => supertest.Agent;
  readonly idem: () => { 'Idempotency-Key': string };
  readonly bearer: (token: string) => { Authorization: string };
  /** Register an all-permission-at-location test principal (kind user) for ad-hoc scenarios. */
  principal(name: string, scope: Scope, permissions?: readonly string[]): string;
  close(): Promise<void>;
}

/** Test principals ("Bearer test:<name>") first, real JWTs otherwise: one app, both kinds of caller. */
class CompositeAuthenticator implements Authenticator {
  constructor(
    private readonly test: TestAuthenticator,
    private readonly jwt: Authenticator,
  ) {}
  authenticate(request: AuthenticationRequest) {
    const header = request.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    return value?.startsWith('Bearer test:')
      ? this.test.authenticate(request)
      : this.jwt.authenticate(request);
  }
}

/**
 * One Postgres + Redis, the real AppModule, a provisioned tenant ("orders-a") with two locations, a
 * legal entity with an ABN, and real users (cashier, supervisor, manager with PINs) whose roles
 * come from the seeded system roles, so the permission catalogue and role limits are the shipped ones.
 */
export async function buildOrdersWorld(): Promise<OrdersWorld> {
  process.env.AUTH_OPERATOR_TOKENS = `${randomUUID()}:${OPERATOR_TOKEN}`;
  const objectStoreDir = await mkdtemp(join(tmpdir(), 'pos-orders-test-'));
  process.env.OBJECT_STORE_LOCAL_DIR = objectStoreDir;
  const [db, redis] = await Promise.all([startPostgresWithSchema(), startRedis()]);
  const t = await createTestApp({
    databaseUrl: db.appUrl,
    redisUrl: redis.url,
    authenticator: 'jwt',
  });
  const ports = t.app.get(KernelPorts);
  ports.bind({ authenticator: new CompositeAuthenticator(t.auth, ports.authenticator) });

  const api = () => supertest(t.server);
  const idem = () => ({ 'Idempotency-Key': randomUUID() });
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  const slug = 'orders-a';
  const provisioned = await api()
    .post('/v1/tenants')
    .set(bearer(OPERATOR_TOKEN))
    .set(idem())
    .send({ slug, name: 'Orders A', admin: { email: 'owner@orders-a.test', displayName: 'Owner' } })
    .expect(201);
  const tenantId = provisioned.body.tenant.id as string;
  const rootOrgUnitId = provisioned.body.rootOrgUnitId as string;
  const ownerToken = t.auth.register(
    'orders-owner',
    userPrincipal(tenantId, { kind: 'tenant', id: tenantId }),
  );

  const entity = await api()
    .post('/v1/legal-entities')
    .set(bearer(ownerToken))
    .set(idem())
    .send({
      name: 'Acme Coffee Pty Ltd',
      countryCode: 'AU',
      taxRegistrationNumber: '12 345 678 901',
      receiptLegalText: 'Prices include GST. Returns within 30 days with this receipt.',
    })
    .expect(201);
  const location = async (code: string, name: string, timezone: string) =>
    (
      await api()
        .post('/v1/locations')
        .set(bearer(ownerToken))
        .set(idem())
        .send({
          orgUnitId: rootOrgUnitId,
          legalEntityId: entity.body.id,
          code,
          name,
          kind: 'store',
          timezone,
          currency: 'AUD',
          address: {
            line1: '1 George St',
            city: 'Sydney',
            region: 'NSW',
            postcode: '2000',
            countryCode: 'AU',
          },
        })
        .expect(201)
    ).body.id as string;
  const locationA = await location('syd-1', 'Acme Sydney CBD', 'Australia/Sydney');
  const locationB = await location('per-1', 'Acme Perth', 'Australia/Perth');
  const registerA = (
    await api()
      .post(`/v1/locations/${locationA}/registers`)
      .set(bearer(ownerToken))
      .set(idem())
      .send({ code: 'R1', name: 'Register 1' })
      .expect(201)
  ).body.id as string;

  const roles = new Map<string, string>();
  for (const r of (await api().get('/v1/roles').set(bearer(ownerToken)).expect(200)).body as Array<{
    key: string;
    id: string;
  }>)
    roles.set(r.key, r.id);

  async function user(
    name: string,
    role: string,
    locationId: string,
    pin?: string,
  ): Promise<Actor> {
    const email = `${name}@orders-a.test`;
    const created = await api()
      .post('/v1/users')
      .set(bearer(ownerToken))
      .set(idem())
      .send({ email, displayName: name, password: PASSWORD })
      .expect(201);
    await api()
      .post('/v1/role-assignments')
      .set(bearer(ownerToken))
      .set(idem())
      .send({
        userId: created.body.id,
        roleId: roles.get(role),
        scope: { kind: 'location', id: locationId },
      })
      .expect(201);
    if (pin)
      await api()
        .put(`/v1/users/${created.body.id}/pin`)
        .set(bearer(ownerToken))
        .set(idem())
        .send({ locationId, pin })
        .expect(204);
    const login = await api()
      .post('/v1/auth/login')
      .send({ tenantSlug: slug, email, password: PASSWORD })
      .expect(200);
    return { id: created.body.id as string, token: login.body.tokens.accessToken as string };
  }
  const managerPin = '4321';
  const supervisorPin = '1111';
  const cashier = await user('cashier', 'cashier', locationA);
  const supervisor = await user('supervisor', 'shift_supervisor', locationA, supervisorPin);
  const manager = await user('manager', 'store_manager', locationA, managerPin);
  const cashierB = await user('cashierb', 'cashier', locationB);

  const foreignHierarchy = await createHierarchyFixture(db.admin, 'orders-b');
  const foreignToken = t.auth.register(
    'orders-foreign-owner',
    userPrincipal(foreignHierarchy.tenantId, { kind: 'tenant', id: foreignHierarchy.tenantId }),
  );

  return {
    db,
    redis,
    t,
    objectStoreDir,
    tenantId,
    slug,
    locationA,
    locationB,
    registerA,
    ownerToken,
    cashier,
    supervisor,
    manager,
    managerPin,
    supervisorPin,
    cashierB,
    foreign: { ...foreignHierarchy, token: foreignToken },
    api,
    idem,
    bearer,
    principal(name, scope, permissions = PERMISSIONS.map((p) => p.key)) {
      return t.auth.register(name, userPrincipal(tenantId, scope, permissions as never));
    },
    async close() {
      await t.close();
      await db.stop();
      await redis.stop();
      await rm(objectStoreDir, { recursive: true, force: true });
    },
  };
}
