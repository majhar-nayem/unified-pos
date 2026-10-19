import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PERMISSIONS, type PermissionKey, type Principal, type Scope } from '@pos/auth';
import { type Pool, createPool, newId } from '@pos/db';
import { Redis } from 'ioredis';

import { AppModule } from '../app.module.js';
import {
  API_PREFIX,
  type AuthenticatedPrincipal,
  type FirstAdminProvisioner,
  type TenantPrincipal,
  KernelPorts,
  PG_POOL,
  RATE_LIMIT_CONFIG,
  RATE_LIMIT_DISABLED,
  type RateLimitConfig,
  REDIS,
  TestAuthenticator,
} from '../modules/kernel/public/index.js';

export interface TestApp {
  readonly app: INestApplication;
  readonly server: ReturnType<INestApplication['getHttpServer']>;
  readonly auth: TestAuthenticator;
  readonly pool: Pool;
  close(): Promise<void>;
}

export interface TestAppOptions {
  readonly databaseUrl: string;
  readonly redisUrl?: string;
  /** A preconfigured client (for example one pointing at a dead host) instead of `redisUrl`. */
  readonly redisClient?: Redis;
  /** Rate limiting is off in tests unless a configuration is given here. */
  readonly rateLimit?: RateLimitConfig;
  /** Stub the identity port (tenancy-only suites) or keep the real one. */
  readonly firstAdmin?: FirstAdminProvisioner;
  /** 'test' binds TestAuthenticator (default); 'jwt' keeps the identity module's JwtAuthenticator. */
  readonly authenticator?: 'test' | 'jwt';
}

/** Boot the real AppModule against Testcontainers (app_rw url) with the chosen authenticator. */
export async function createTestApp(options: TestAppOptions): Promise<TestApp> {
  const pool = createPool({
    connectionString: options.databaseUrl,
    max: 4,
    applicationName: 'pos-api-test',
  });
  const auth = new TestAuthenticator();
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PG_POOL)
    .useValue(pool);
  const redis = options.redisClient ?? (options.redisUrl ? new Redis(options.redisUrl) : undefined);
  if (redis) builder.overrideProvider(REDIS).useValue(redis);
  builder.overrideProvider(RATE_LIMIT_CONFIG).useValue(options.rateLimit ?? RATE_LIMIT_DISABLED);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: false, rawBody: true }); // raw body for webhook signature tests (S-F5)
  app.setGlobalPrefix(API_PREFIX);
  await app.init();
  app.get(KernelPorts).bind({
    ...(options.authenticator === 'jwt' ? {} : { authenticator: auth }),
    ...(options.firstAdmin ? { firstAdminProvisioner: options.firstAdmin } : {}),
  });
  return {
    app,
    server: app.getHttpServer(),
    auth,
    pool,
    async close() {
      await app.close();
      redis?.disconnect();
      await pool.end().catch(() => undefined);
    },
  };
}

export const ALL_PERMISSIONS: readonly PermissionKey[] = PERMISSIONS.map((p) => p.key);

/** A user principal holding `permissions` at one scope. */
export function userPrincipal(
  tenantId: string,
  scope: Scope,
  permissions: readonly PermissionKey[] = ALL_PERMISSIONS,
  extra: Partial<Principal> = {},
): TenantPrincipal {
  return {
    tenantId,
    subjectId: newId(),
    kind: 'user',
    mfaVerified: true,
    assignmentsVersion: 1,
    assignments: [{ assignmentId: newId(), role: 'test', permissions, scope, coveredScopeIds: [] }],
    tokenKind: 'web',
    ...extra,
  };
}

export function operatorPrincipal(): AuthenticatedPrincipal {
  return { kind: 'operator', operatorId: newId(), tenantId: null };
}

/** Stand-in for the identity module's first-admin port: inserts an invited user row. */
export const stubFirstAdmin: FirstAdminProvisioner = {
  async createFirstAdmin(uow, input) {
    const userId = newId();
    await uow.db.query(
      "INSERT INTO identity.users (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'invited')",
      [userId, input.tenantId, input.email, input.displayName],
    );
    return { userId, inviteToken: 'stub-invite-token' };
  },
};
