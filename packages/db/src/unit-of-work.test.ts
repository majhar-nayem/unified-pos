import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { runInTenantTransaction } from './unit-of-work.js';

const TENANT = '0190f8a0-0000-7000-8000-00000000000a';

function fakePool() {
  const log: string[] = [];
  let released = 0;
  const client = {
    query: async (text: string, params?: unknown[]) => {
      log.push(text.trim().split('\n')[0]!.slice(0, 60));
      if (text.includes('current_tenant')) return { rows: [{ tenant: TENANT }] };
      if (text.includes('nextval'))
        return {
          rows: Array.from({ length: Number(params?.[0] ?? 0) }, (_, i) => ({
            seq: BigInt(i + 1),
          })),
        };
      if (text.includes('audit_chain_heads') && text.includes('FOR UPDATE')) return { rows: [] };
      return { rows: [], rowCount: 0 };
    },
    release: () => void (released += 1),
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, log, released: () => released };
}

describe('runInTenantTransaction', () => {
  it('sets the tenant context before running fn and commits after flushing outbox then audit', async () => {
    const { pool, log, released } = fakePool();
    const committed: string[] = [];
    const result = await runInTenantTransaction(
      pool,
      TENANT,
      async (uow) => {
        expect(uow.tenantId).toBe(TENANT);
        await uow.db.query('SELECT 1 -- domain write');
        uow.emit({
          type: 'config.changed',
          aggregateKind: 'config_entry',
          aggregateId: TENANT,
          payload: {},
        });
        uow.audit({
          action: 'tenancy.config.changed',
          resourceKind: 'config_entry',
          after: { v: 1 },
        });
        uow.onCommitted(() => void committed.push('cb'));
        return 42;
      },
      { actor: { kind: 'user', id: TENANT } },
    );
    expect(result).toBe(42);
    expect(committed).toEqual(['cb']);
    expect(released()).toBe(1);
    const index = (needle: string) => log.findIndex((l) => l.includes(needle));
    expect(index('BEGIN')).toBeLessThan(index("set_config('app.tenant_id'"));
    expect(index("set_config('app.tenant_id'")).toBeLessThan(index('domain write'));
    expect(index('domain write')).toBeLessThan(index('INSERT INTO audit.outbox_events'));
    expect(index('INSERT INTO audit.outbox_events')).toBeLessThan(
      index('INSERT INTO audit.audit_log'),
    );
    expect(index('INSERT INTO audit.audit_log')).toBeLessThan(index('COMMIT'));
  });

  it('rolls back on error, releases the client and skips onCommitted', async () => {
    const { pool, log, released } = fakePool();
    const committed: string[] = [];
    await expect(
      runInTenantTransaction(pool, TENANT, async (uow) => {
        uow.onCommitted(() => void committed.push('cb'));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(log).toContain('ROLLBACK');
    expect(log).not.toContain('COMMIT');
    expect(committed).toEqual([]);
    expect(released()).toBe(1);
  });

  it('rejects a non-uuid tenant id before touching the pool', async () => {
    const { pool, log } = fakePool();
    await expect(runInTenantTransaction(pool, 'nope', async () => 1)).rejects.toThrow(TypeError);
    expect(log).toEqual([]);
  });

  it('refuses to proceed when the tenant context did not stick', async () => {
    const { pool } = fakePool();
    (pool as unknown as { connect: () => Promise<unknown> }).connect = async () => ({
      query: async (text: string) =>
        text.includes('current_tenant') ? { rows: [{ tenant: null }] } : { rows: [] },
      release: () => undefined,
    });
    await expect(runInTenantTransaction(pool, TENANT, async () => 1)).rejects.toThrow(
      /RLS tenant context/,
    );
  });
});
