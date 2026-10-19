import type { TenantScopedDb } from '@pos/db';
import { describe, expect, it } from 'vitest';

import { buildPatch, queryPage } from './sql.js';

describe('buildPatch', () => {
  const columns = {
    name: 'name',
    rules: { column: 'rules', json: true },
    taxInclusive: 'tax_inclusive',
  } as const;
  it('builds numbered SET fragments from the fields present, skipping undefined', () => {
    expect(buildPatch({ name: 'x', taxInclusive: false }, columns, 3)).toEqual({
      set: 'name = $3, tax_inclusive = $4',
      params: ['x', false],
    });
    expect(buildPatch({ name: undefined }, columns)).toEqual({ set: '', params: [] });
    expect(buildPatch({}, columns, 1)).toEqual({ set: '', params: [] });
  });
  it('serialises json columns and ignores unknown fields', () => {
    expect(buildPatch({ rules: { a: 1 }, nope: 1 }, columns, 5)).toEqual({
      set: 'rules = $5',
      params: ['{"a":1}'],
    });
  });
  it('keeps null (a deliberate clear) but not undefined', () => {
    expect(buildPatch({ name: null }, columns)).toEqual({ set: 'name = $1', params: [null] });
  });
});

describe('queryPage', () => {
  const fakeDb = (rows: { id: string }[]) => {
    const calls: { text: string; params: unknown[] }[] = [];
    const db = {
      tenantId: 'tenant-1',
      query: async (text: string, params: unknown[]) => {
        calls.push({ text, params });
        return rows;
      },
    } as unknown as TenantScopedDb;
    return { db, calls };
  };

  it('asks for one extra row and returns the last id of the page as the cursor', async () => {
    const { db, calls } = fakeDb([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const page = await queryPage(db, { from: 'x.t t', limit: 2 }, (r: { id: string }) => r.id);
    expect(page).toEqual({ items: ['a', 'b'], nextCursor: 'b' });
    expect(calls[0]!.text).toContain('LIMIT 3');
    expect(calls[0]!.text).toContain('ORDER BY t.id');
    expect(calls[0]!.params).toEqual(['tenant-1']);
  });

  it('has no next cursor on the last page, and numbers filters and the cursor in order', async () => {
    const { db, calls } = fakeDb([{ id: 'a' }]);
    const page = await queryPage(
      db,
      {
        from: 'x.t t',
        alias: 't',
        where: [{ sql: 't.status = ?', value: 'active' }],
        cursor: 'prev',
        limit: 5,
      },
      (r: { id: string }) => r.id,
    );
    expect(page).toEqual({ items: ['a'], nextCursor: null });
    expect(calls[0]!.text).toContain('t.tenant_id = $1 AND t.status = $2 AND t.id > $3');
    expect(calls[0]!.params).toEqual(['tenant-1', 'active', 'prev']);
  });

  it('an empty result is an empty page', async () => {
    const { db } = fakeDb([]);
    expect(await queryPage(db, { from: 'x.t t', limit: 5 }, (r: { id: string }) => r.id)).toEqual({
      items: [],
      nextCursor: null,
    });
  });
});
