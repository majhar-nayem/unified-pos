import { readInTenant, runInTenantTransaction, verifyAuditChain } from '@pos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTenantFixture } from './fixtures.js';
import { startPostgresWithSchema, type TestPostgres } from './postgres.js';

describe('audit hash chain', () => {
  let db: TestPostgres;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    db = await startPostgresWithSchema();
    tenantA = (await createTenantFixture(db.admin, 'chain-a')).tenantId;
    tenantB = (await createTenantFixture(db.admin, 'chain-b')).tenantId;
  });

  afterAll(async () => {
    await db?.stop();
  });

  const append = (tenantId: string, n: number, writer: string) =>
    Promise.all(
      Array.from({ length: n }, (_, i) =>
        runInTenantTransaction(
          db.app,
          tenantId,
          async (uow) => {
            uow.audit({ action: 'test.write', resourceKind: 'thing', after: { writer, i } });
          },
          { actor: { kind: 'user', id: null } },
        ),
      ),
    );

  const verify = (tenantId: string) =>
    readInTenant(db.app, tenantId, (t) => verifyAuditChain(t, { batchSize: 7 }));

  it('verifies after 50 appends from two concurrent writers', async () => {
    await Promise.all([append(tenantA, 25, 'w1'), append(tenantA, 25, 'w2')]);
    const result = await verify(tenantA);
    expect(result).toMatchObject({ ok: true, checked: 50, headMatches: true });
    const rows = await db.admin.query<{ prev_hash: Buffer | null }>(
      'SELECT prev_hash FROM audit.audit_log WHERE tenant_id = $1 ORDER BY seq',
      [tenantA],
    );
    expect(rows.rows[0]!.prev_hash).toBeNull();
    expect(rows.rows.slice(1).every((r) => r.prev_hash !== null)).toBe(true);
  });

  it('chains are per tenant', async () => {
    await append(tenantB, 3, 'b');
    expect(await verify(tenantB)).toMatchObject({ ok: true, checked: 3 });
    expect(await verify(tenantA)).toMatchObject({ ok: true, checked: 50 });
  });

  it('tamper test: editing a middle row breaks verification at that seq; tenant B is unaffected', async () => {
    const target = await db.admin.query<{ seq: bigint }>(
      'SELECT seq FROM audit.audit_log WHERE tenant_id = $1 ORDER BY seq OFFSET 20 LIMIT 1',
      [tenantA],
    );
    const seq = target.rows[0]!.seq;
    await db.admin.query('ALTER TABLE audit.audit_log DISABLE TRIGGER trg_audit_log_append_only');
    try {
      await db.admin.query(
        `UPDATE audit.audit_log SET after = '{"writer":"evil"}' WHERE tenant_id = $1 AND seq = $2`,
        [tenantA, seq],
      );
    } finally {
      await db.admin.query('ALTER TABLE audit.audit_log ENABLE TRIGGER trg_audit_log_append_only');
    }
    const broken = await verify(tenantA);
    expect(broken.ok).toBe(false);
    expect(broken.firstBrokenSeq).toBe(seq);
    expect(await verify(tenantB)).toMatchObject({ ok: true });
  });

  it('tamper test: deleting the last row makes the head mismatch', async () => {
    await append(tenantB, 2, 'b2');
    expect(await verify(tenantB)).toMatchObject({ ok: true, checked: 5 });
    await db.admin.query('ALTER TABLE audit.audit_log DISABLE TRIGGER trg_audit_log_append_only');
    try {
      await db.admin.query(
        'DELETE FROM audit.audit_log WHERE tenant_id = $1 AND seq = (SELECT max(seq) FROM audit.audit_log WHERE tenant_id = $1)',
        [tenantB],
      );
    } finally {
      await db.admin.query('ALTER TABLE audit.audit_log ENABLE TRIGGER trg_audit_log_append_only');
    }
    const result = await verify(tenantB);
    expect(result).toMatchObject({ ok: false, checked: 4, headMatches: false });
    expect(result.firstBrokenSeq).toBeUndefined();
  });

  it('the app role cannot update or delete audit rows (append-only trigger + grants)', async () => {
    await expect(
      db.app.query("UPDATE audit.audit_log SET reason = 'x' WHERE tenant_id = $1", [tenantB]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('audit rows are written in the same transaction as the domain write: a rollback drops both', async () => {
    const before = await db.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit.audit_log WHERE tenant_id = $1',
      [tenantB],
    );
    await expect(
      runInTenantTransaction(db.app, tenantB, async (uow) => {
        await uow.db.query(
          "INSERT INTO tenancy.legal_entities (tenant_id, name, country_code) VALUES ($1, 'Doomed', 'AU')",
          [tenantB],
        );
        uow.audit({ action: 'test.doomed', resourceKind: 'legal_entity' });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    const after = await db.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit.audit_log WHERE tenant_id = $1',
      [tenantB],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    const doomed = await db.admin.query(
      "SELECT 1 FROM tenancy.legal_entities WHERE name = 'Doomed'",
    );
    expect(doomed.rows).toHaveLength(0);
  });
});
