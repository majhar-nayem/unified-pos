import {
  completeIdempotencyKey,
  purgeExpiredIdempotencyKeys,
  releaseIdempotencyKey,
  reserveIdempotencyKey,
  runInTenantTransaction,
  withoutTenant,
} from '@pos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTenantFixture } from './fixtures.js';
import { startPostgresWithSchema, type TestPostgres } from './postgres.js';

describe('idempotency keys', () => {
  let db: TestPostgres;
  let tenant: string;
  const ref = { scope: 'user:u1:tenancy.location.create', key: 'key-0001' };

  beforeAll(async () => {
    db = await startPostgresWithSchema();
    tenant = (await createTenantFixture(db.admin, 'idem')).tenantId;
  });

  afterAll(async () => {
    await db?.stop();
  });

  const tx = <T>(fn: Parameters<typeof runInTenantTransaction<T>>[2]) =>
    runInTenantTransaction(db.app, tenant, fn);

  it('reserve → in_flight → complete → replay; a different hash is a mismatch', async () => {
    expect(await tx((uow) => reserveIdempotencyKey(uow.db, ref, 'hash-a'))).toEqual({
      outcome: 'reserved',
    });
    expect(await tx((uow) => reserveIdempotencyKey(uow.db, ref, 'hash-a'))).toEqual({
      outcome: 'in_flight',
    });
    expect(await tx((uow) => reserveIdempotencyKey(uow.db, ref, 'hash-b'))).toEqual({
      outcome: 'mismatch',
    });
    await tx((uow) => completeIdempotencyKey(uow.db, ref, { status: 201, body: { id: 'x' } }));
    expect(await tx((uow) => reserveIdempotencyKey(uow.db, ref, 'hash-a'))).toEqual({
      outcome: 'replay',
      status: 201,
      body: { id: 'x' },
    });
    expect(await tx((uow) => reserveIdempotencyKey(uow.db, ref, 'hash-b'))).toEqual({
      outcome: 'mismatch',
    });
  });

  it('release drops an unfinished reservation so the client can retry', async () => {
    const other = { ...ref, key: 'key-0002' };
    expect(await tx((uow) => reserveIdempotencyKey(uow.db, other, 'h'))).toEqual({
      outcome: 'reserved',
    });
    await tx((uow) => releaseIdempotencyKey(uow.db, other));
    expect(await tx((uow) => reserveIdempotencyKey(uow.db, other, 'h2'))).toEqual({
      outcome: 'reserved',
    });
    await tx((uow) => completeIdempotencyKey(uow.db, other, { status: 200, body: null }));
    await tx((uow) => releaseIdempotencyKey(uow.db, other)); // completed rows are never released
    expect(await tx((uow) => reserveIdempotencyKey(uow.db, other, 'h2'))).toMatchObject({
      outcome: 'replay',
      status: 200,
    });
  });

  it('expired keys are reclaimed on reserve and purged by the worker job across tenants', async () => {
    await db.admin.query(
      "UPDATE audit.idempotency_keys SET expires_at = now() - interval '1 minute' WHERE key = $1",
      [ref.key],
    );
    expect(await tx((uow) => reserveIdempotencyKey(uow.db, ref, 'hash-new'))).toEqual({
      outcome: 'reserved',
    });
    await db.admin.query(
      "UPDATE audit.idempotency_keys SET expires_at = now() - interval '1 minute'",
    );
    const purged = await withoutTenant(db.app, (client) => purgeExpiredIdempotencyKeys(client));
    expect(purged).toBe(2);
    const left = await db.admin.query('SELECT count(*)::int AS n FROM audit.idempotency_keys');
    expect(left.rows[0].n).toBe(0);
  });

  it('keys are tenant-scoped: another tenant with the same scope and key does not collide', async () => {
    const other = (await createTenantFixture(db.admin, 'idem-2')).tenantId;
    expect(
      await runInTenantTransaction(db.app, tenant, (uow) =>
        reserveIdempotencyKey(uow.db, ref, 'h'),
      ),
    ).toEqual({ outcome: 'reserved' });
    expect(
      await runInTenantTransaction(db.app, other, (uow) =>
        reserveIdempotencyKey(uow.db, ref, 'different'),
      ),
    ).toEqual({ outcome: 'reserved' });
  });
});
