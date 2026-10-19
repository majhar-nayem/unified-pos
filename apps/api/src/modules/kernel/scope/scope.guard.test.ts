import type { Principal } from '@pos/auth';
import { describe, expect, it } from 'vitest';

import { principalReaches } from './scope.guard.js';

const ids = {
  tenant: 't',
  root: 'ou-root',
  child: 'ou-child',
  locA: 'loc-a',
  locB: 'loc-b',
  regA: 'reg-a',
};
const resolvedRegA = {
  kind: 'register' as const,
  id: ids.regA,
  path: [
    { kind: 'register' as const, id: ids.regA },
    { kind: 'location' as const, id: ids.locA },
    { kind: 'org_unit' as const, id: ids.child },
    { kind: 'org_unit' as const, id: ids.root },
    { kind: 'tenant' as const, id: ids.tenant },
  ],
};
const resolvedLocB = {
  kind: 'location' as const,
  id: ids.locB,
  path: [
    { kind: 'location' as const, id: ids.locB },
    { kind: 'org_unit' as const, id: ids.root },
    { kind: 'tenant' as const, id: ids.tenant },
  ],
};

function principalAt(
  kind: 'tenant' | 'org_unit' | 'location' | 'register',
  id: string,
  covered: string[] = [],
): Principal {
  return {
    tenantId: ids.tenant,
    subjectId: 'u',
    kind: 'user',
    mfaVerified: false,
    assignmentsVersion: 1,
    assignments: [
      {
        assignmentId: 'a',
        role: 'r',
        permissions: ['x.y'],
        scope: { kind, id },
        coveredScopeIds: covered,
      },
    ],
  };
}

describe('principalReaches', () => {
  it('a tenant-wide assignment reaches everything', () => {
    expect(principalReaches(principalAt('tenant', ids.tenant), resolvedRegA)).toBe(true);
    expect(principalReaches(principalAt('tenant', ids.tenant), resolvedLocB)).toBe(true);
  });

  it('an assignment on an ancestor org unit reaches the register below it, not a sibling branch', () => {
    expect(principalReaches(principalAt('org_unit', ids.child), resolvedRegA)).toBe(true);
    expect(principalReaches(principalAt('org_unit', ids.child), resolvedLocB)).toBe(false);
  });

  it('a location assignment reaches its own registers and nothing else (F1 acceptance: 404 for Location B)', () => {
    expect(principalReaches(principalAt('location', ids.locA), resolvedRegA)).toBe(true);
    expect(principalReaches(principalAt('location', ids.locA), resolvedLocB)).toBe(false);
  });

  it('explicit coveredScopeIds (devices, api clients) reach listed targets', () => {
    expect(principalReaches(principalAt('location', ids.locA, [ids.locB]), resolvedLocB)).toBe(
      true,
    );
  });

  it('no assignments → nothing', () => {
    expect(
      principalReaches({ ...principalAt('location', ids.locA), assignments: [] }, resolvedRegA),
    ).toBe(false);
  });
});
