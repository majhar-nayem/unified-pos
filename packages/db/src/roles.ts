import type { PoolClient } from 'pg';

/** Module schemas from db/schema.sql. platform.* is operator-only and read-only for the app role. */
export const MODULE_SCHEMAS = [
  'platform',
  'tenancy',
  'identity',
  'workforce',
  'catalog',
  'pricing',
  'inventory',
  'orders',
  'payments',
  'cash',
  'tables',
  'kitchen',
  'customers',
  'devices',
  'audit',
  'integrations',
  'reporting',
] as const;

/** SECURITY DEFINER / cross-tenant functions from migration 0002 the app role may execute. */
export const APP_ROLE_FUNCTIONS = [
  'audit.fn_claim_outbox_batch',
  'audit.fn_mark_outbox_published',
  'audit.fn_mark_outbox_failed',
  'audit.fn_mark_outbox_dead',
  'audit.fn_purge_idempotency_keys',
  'platform.fn_provision_tenant',
  'platform.fn_activate_tenant',
  'identity.fn_seed_access_catalog',
  'catalog.fn_search_items', // F2 (S-F2)
] as const;

const ROLE_NAME = /^[a-z_][a-z0-9_]*$/;

/** Create the non-superuser, non-BYPASSRLS application role if it does not exist (local/dev/test only). */
export async function ensureAppRole(
  client: PoolClient,
  role: string,
  password: string,
): Promise<void> {
  assertRoleName(role);
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (exists.rowCount === 0) {
    await client.query(
      `CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${quoteLiteral(password)}`,
    );
  }
}

/**
 * Grant matrix for the application role (docs/releases/f1.md). Idempotent; rerun after every migration.
 *  - USAGE on every module schema; SELECT/INSERT/UPDATE/DELETE on tenant tables (RLS does the isolation)
 *  - platform.*: SELECT only (tenants are provisioned through SECURITY DEFINER functions)
 *  - identity.permissions: SELECT only (seeded through identity.fn_seed_access_catalog)
 *  - audit.audit_log: no UPDATE/DELETE (append-only; the trigger forbids it anyway)
 *  - EXECUTE on the cross-tenant functions listed in APP_ROLE_FUNCTIONS
 */
export async function grantAppRole(client: PoolClient, role: string): Promise<void> {
  assertRoleName(role);
  for (const schema of MODULE_SCHEMAS) {
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
    );
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
  }
  await client.query(`REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA platform FROM ${role}`);
  await client.query(`REVOKE INSERT, UPDATE, DELETE ON identity.permissions FROM ${role}`);
  await client.query(`REVOKE UPDATE, DELETE ON audit.audit_log FROM ${role}`);

  const functions = await client.query<{ signature: string }>(
    `SELECT p.oid::regprocedure::text AS signature
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE (n.nspname || '.' || p.proname) = ANY($1::text[])`,
    [[...APP_ROLE_FUNCTIONS]],
  );
  for (const fn of functions.rows) {
    await client.query(`GRANT EXECUTE ON FUNCTION ${fn.signature} TO ${role}`);
  }
}

function assertRoleName(role: string): void {
  if (!ROLE_NAME.test(role)) throw new TypeError(`Invalid role name "${role}"`);
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
