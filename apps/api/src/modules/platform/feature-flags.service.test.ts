import { describe, expect, it } from 'vitest';

import { pickFlag } from './feature-flags.service.js';

describe('pickFlag', () => {
  const ctx = { tenantId: 't1', orgUnitIds: ['ou1'], locationId: 'loc1' };
  it('nearest scope wins', () => {
    const rows = [
      { scope_kind: 'platform' as const, scope_id: null, enabled: false },
      { scope_kind: 'tenant' as const, scope_id: 't1', enabled: true },
      { scope_kind: 'location' as const, scope_id: 'loc1', enabled: false },
    ];
    expect(pickFlag(rows, ctx)).toBe(false);
    expect(pickFlag(rows.slice(0, 2), ctx)).toBe(true);
    expect(pickFlag(rows.slice(0, 1), ctx)).toBe(false);
  });
  it('ignores rows for other tenants, org units or locations and defaults to false', () => {
    expect(
      pickFlag(
        [
          { scope_kind: 'location', scope_id: 'other', enabled: true },
          { scope_kind: 'org_unit', scope_id: 'ou9', enabled: true },
        ],
        ctx,
      ),
    ).toBe(false);
    expect(pickFlag([{ scope_kind: 'org_unit', scope_id: 'ou1', enabled: true }], ctx)).toBe(true);
    expect(pickFlag([], ctx)).toBe(false);
  });
});
