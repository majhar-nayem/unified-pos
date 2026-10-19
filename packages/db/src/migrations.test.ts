import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MIGRATIONS, readMigrationSql, repoRoot } from './migrations.js';

describe('migration manifest', () => {
  it('migration 0001 points at the three canonical schema files, in order', () => {
    const first = MIGRATIONS[0]!;
    expect(first.id).toBe('0001');
    expect(first.files).toEqual(['db/schema.sql', 'db/schema_part2.sql', 'db/schema_part3.sql']);
    for (const file of first.files) expect(existsSync(resolve(repoRoot(), file))).toBe(true);
  });

  it('concatenates the files with markers', () => {
    const sql = readMigrationSql(MIGRATIONS[0]!);
    expect(sql).toContain('-- >>> db/schema.sql');
    expect(sql).toContain('-- >>> db/schema_part3.sql');
    expect(sql).toContain('CREATE POLICY tenant_isolation');
  });

  it('migration 0002 is registered and defines the F1 objects', () => {
    const second = MIGRATIONS[1]!;
    expect(second.id).toBe('0002');
    const sql = readMigrationSql(second);
    for (const needle of [
      'CREATE POLICY rp_select',
      'fn_assert_role_tenant',
      'fn_assert_scope_ref',
      'fn_scope_path',
      'fn_claim_outbox_batch',
      'fn_seed_access_catalog',
      'prev_refresh_token_hash',
      'uq_business_days_open',
    ]) {
      expect(sql).toContain(needle);
    }
  });

  it('has unique, sorted ids', () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
});
