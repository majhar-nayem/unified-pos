import { describe, expect, it } from 'vitest';

import { AuditListQuerySchema } from './audit.contracts.js';
import { buildAuditFilter } from './audit.service.js';

describe('buildAuditFilter', () => {
  it('always pins tenant_id and numbers the parameters after it', () => {
    const query = AuditListQuerySchema.parse({
      resourceKind: 'location',
      cursor: '10',
      limit: '5',
    });
    expect(buildAuditFilter(query)).toEqual({
      where: 'tenant_id = $1 AND resource_kind = $2 AND seq > $3',
      params: ['location', 10],
    });
    expect(buildAuditFilter(AuditListQuerySchema.parse({}))).toEqual({
      where: 'tenant_id = $1',
      params: [],
    });
  });

  it('applies time bounds as a half-open interval', () => {
    const query = AuditListQuerySchema.parse({
      from: '2026-10-18T00:00:00Z',
      to: '2026-10-19T00:00:00Z',
    });
    expect(buildAuditFilter(query).where).toBe(
      'tenant_id = $1 AND occurred_at >= $2 AND occurred_at < $3',
    );
  });
});
