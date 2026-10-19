import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  AUDIT_HASH_FIELDS,
  type AuditRowForHash,
  auditHash,
  auditRowCanonical,
  bytesEqual,
} from './chain.js';

const row: AuditRowForHash = {
  id: '0190f8a0-0000-7000-8000-000000000001',
  tenant_id: '0190f8a0-0000-7000-8000-00000000000a',
  seq: 7n,
  actor_kind: 'user',
  actor_id: '0190f8a0-0000-7000-8000-000000000002',
  on_behalf_of: null,
  device_id: null,
  location_id: null,
  action: 'tenancy.config.changed',
  resource_kind: 'config_entry',
  resource_id: null,
  before: { value: 1 },
  after: { value: 2 },
  reason: null,
  approval_id: null,
  correlation_id: null,
  occurred_at: new Date('2026-10-18T03:00:00.000Z'),
};

describe('audit hash chain', () => {
  it('genesis hash is sha256 of the canonical row alone', () => {
    const expected = createHash('sha256').update(auditRowCanonical(row), 'utf8').digest();
    expect(auditHash(null, row).equals(expected)).toBe(true);
    expect(auditHash(Buffer.alloc(0), row).equals(expected)).toBe(true);
  });

  it('chains on the previous hash', () => {
    const prev = auditHash(null, row);
    const expected = createHash('sha256')
      .update(prev)
      .update(auditRowCanonical(row), 'utf8')
      .digest();
    expect(auditHash(prev, row).equals(expected)).toBe(true);
    expect(auditHash(prev, row).equals(auditHash(null, row))).toBe(false);
  });

  it('changes when any hashed field changes, and seq/occurred_at representation is normalised', () => {
    const base = auditHash(null, row);
    for (const field of AUDIT_HASH_FIELDS) {
      const mutated = {
        ...row,
        [field]:
          field === 'occurred_at' ? new Date('2027-01-01T00:00:00Z') : field === 'seq' ? 8n : 'x',
      };
      expect(auditHash(null, mutated as AuditRowForHash).equals(base)).toBe(false);
    }
    expect(
      auditHash(null, { ...row, seq: '7', occurred_at: '2026-10-18T03:00:00.000Z' }).equals(base),
    ).toBe(true);
  });

  it('ignores ip and stored hashes (not part of the canonical row)', () => {
    const withExtras = {
      ...row,
      ip: '10.0.0.1',
      hash: Buffer.from('zz'),
      prev_hash: null,
    } as AuditRowForHash;
    expect(auditHash(null, withExtras).equals(auditHash(null, row))).toBe(true);
  });

  it('bytesEqual treats null and empty as equal', () => {
    expect(bytesEqual(null, Buffer.alloc(0))).toBe(true);
    expect(bytesEqual(Buffer.from('a'), Buffer.from('a'))).toBe(true);
    expect(bytesEqual(Buffer.from('a'), null)).toBe(false);
  });
});
