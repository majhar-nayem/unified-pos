import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createPool, ensureAppRole, grantAppRole, migrate, type Pool } from '@pos/db';

export const POSTGRES_IMAGE = 'postgres:16';

/** Non-superuser application role. RLS is FORCEd on every tenant table, and superusers bypass RLS. */
export const APP_ROLE = 'app_rw';
const APP_PASSWORD = 'app_rw';

export interface TestPostgres {
  readonly container: StartedPostgreSqlContainer;
  /** Superuser connection: fixtures, assertions that must see across tenants. Bypasses RLS. */
  readonly admin: Pool;
  /** Application-role connection: what the API uses. Subject to RLS and the grant matrix. */
  readonly app: Pool;
  readonly adminUrl: string;
  readonly appUrl: string;
  stop(): Promise<void>;
}

/**
 * Start postgres:16, apply every migration (db/schema*.sql as 0001, then 0002…) and create the
 * `app_rw` role with the grant matrix from @pos/db (`grantAppRole`). Reused by every integration suite.
 */
export async function startPostgresWithSchema(): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('pos_test')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  const adminUrl = container.getConnectionUri();
  const admin = createPool({
    connectionString: adminUrl,
    max: 4,
    applicationName: 'pos-test-admin',
  });
  await migrate(admin);
  const client = await admin.connect();
  try {
    await ensureAppRole(client, APP_ROLE, APP_PASSWORD);
    await grantAppRole(client, APP_ROLE);
  } finally {
    client.release();
  }

  const appUrl = adminUrl.replace(
    /^postgres(ql)?:\/\/[^@]+@/,
    `postgres://${APP_ROLE}:${APP_PASSWORD}@`,
  );
  const app = createPool({ connectionString: appUrl, max: 4, applicationName: 'pos-test-app' });

  return {
    container,
    admin,
    app,
    adminUrl,
    appUrl,
    async stop() {
      await app.end();
      await admin.end();
      await container.stop();
    },
  };
}
