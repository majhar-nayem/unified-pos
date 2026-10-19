import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { NAV, pageAllowed } from '@/lib/nav';
import { mockSession } from '@/test/session';

import { SessionValueProvider, usePermissions } from './session';

let current = mockSession();
const wrapper = ({ children }: { children: ReactNode }) => (
  <SessionValueProvider value={current as never}>{children}</SessionValueProvider>
);
const permissions = () => renderHook(() => usePermissions(), { wrapper });

const TENANT = '0190a000-0000-7000-8000-000000000001';
const LOCATION_A = '0190a000-0000-7000-8000-00000000000a';
const LOCATION_B = '0190a000-0000-7000-8000-00000000000b';

describe('permission gating shares @pos/auth with the server', () => {
  it('has() is true only when an active assignment grants the key', () => {
    current = mockSession({
      permissions: ['tenancy.location.view', 'orders.discount.apply'],
      assignments: [
        {
          assignmentId: 'a1',
          role: 'store_manager',
          permissions: ['tenancy.location.view'],
          scope: { kind: 'location', id: LOCATION_A },
          coveredScopeIds: [],
        },
        {
          assignmentId: 'a2',
          role: 'expired',
          permissions: ['orders.discount.apply'],
          scope: { kind: 'tenant', id: TENANT },
          coveredScopeIds: [],
          validTo: '2000-01-01T00:00:00.000Z',
        },
      ],
    });
    const { result } = permissions();
    expect(result.current.has('tenancy.location.view')).toBe(true);
    // Listed in the union but its only assignment has expired: the evaluator says no.
    expect(result.current.has('orders.discount.apply')).toBe(false);
    expect(result.current.has('audit.view')).toBe(false);
  });

  it('canAt() applies scope coverage and limits like the API does', () => {
    current = mockSession({
      permissions: ['orders.discount.apply'],
      assignments: [
        {
          assignmentId: 'a1',
          role: 'cashier',
          permissions: ['orders.discount.apply'],
          scope: { kind: 'location', id: LOCATION_A },
          coveredScopeIds: [],
          limits: { 'orders.discount.max_percent': 10 },
        },
      ],
    });
    const { result } = permissions();
    expect(
      result.current.canAt('orders.discount.apply', { kind: 'location', id: LOCATION_A }).allowed,
    ).toBe(true);
    expect(
      result.current.canAt('orders.discount.apply', { kind: 'location', id: LOCATION_B }),
    ).toMatchObject({ allowed: false, reason: 'out_of_scope' });
    expect(
      result.current.canAt(
        'orders.discount.apply',
        { kind: 'location', id: LOCATION_A },
        { 'orders.discount.max_percent': 25 },
      ),
    ).toMatchObject({ allowed: false, reason: 'limit_exceeded' });
  });

  it('a tenant-wide assignment covers every scope and canTenant()', () => {
    current = mockSession({
      permissions: ['identity.user.manage'],
      assignments: [
        {
          assignmentId: 'a1',
          role: 'admin',
          permissions: ['identity.user.manage'],
          scope: { kind: 'tenant', id: TENANT },
          coveredScopeIds: [],
        },
      ],
    });
    const { result } = permissions();
    expect(result.current.canTenant('identity.user.manage')).toBe(true);
    expect(
      result.current.canAt('identity.user.manage', { kind: 'register', id: LOCATION_B }).allowed,
    ).toBe(true);
  });

  it('nothing is allowed without a principal', () => {
    current = { ...mockSession(), principal: null as never };
    const { result } = permissions();
    expect(result.current.has('tenancy.location.view')).toBe(false);
    expect(result.current.canTenant('tenancy.location.view')).toBe(false);
  });
});

describe('navigation model', () => {
  const has =
    (...keys: string[]) =>
    (k: string) =>
      keys.includes(k);
  it('maps every page to the view permission of its list endpoint', () => {
    expect(NAV.find((n) => n.href === '/audit')?.anyOf).toEqual(['audit.view']);
    expect(NAV.find((n) => n.href === '/devices')?.anyOf).toEqual(['devices.view']);
    expect(NAV.find((n) => n.href === '/')?.anyOf).toEqual([]);
  });
  it('pageAllowed matches the longest prefix and always allows home', () => {
    expect(pageAllowed('/', has())).toBe(true);
    expect(pageAllowed('/audit', has())).toBe(false);
    expect(pageAllowed('/audit', has('audit.view'))).toBe(true);
    expect(pageAllowed('/unknown', has())).toBe(true);
  });
  it('referenced keys all exist in the @pos/auth catalogue', async () => {
    const { PERMISSION_KEYS } = await import('@pos/auth');
    for (const item of NAV) for (const key of item.anyOf) expect(PERMISSION_KEYS).toContain(key);
  });
});
