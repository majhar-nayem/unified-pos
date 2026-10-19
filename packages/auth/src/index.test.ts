import { describe, expect, it } from 'vitest';

import { type Assignment, type Principal, can, mergeLimits, requiresMfa } from './index.js';

const base: Omit<Principal, 'assignments'> = {
  tenantId: 't1',
  subjectId: 'u1',
  kind: 'user',
  mfaVerified: false,
  assignmentsVersion: 1,
};

const cashierAssignment: Assignment = {
  assignmentId: 'a-cashier',
  role: 'cashier',
  permissions: ['orders.create', 'orders.discount.apply'],
  scope: { kind: 'location', id: 'loc-1' },
  coveredScopeIds: ['reg-1', 'reg-2'],
  limits: { 'orders.discount.max_percent': 10 },
};

const cashier: Principal = { ...base, assignments: [cashierAssignment] };

const principalWith = (...assignments: Assignment[]): Principal => ({ ...base, assignments });

describe('can()', () => {
  it('grants within scope and limits, naming the assignment', () => {
    expect(
      can(
        cashier,
        'orders.discount.apply',
        { kind: 'register', id: 'reg-1' },
        { attributes: { 'orders.discount.max_percent': 10 } },
      ),
    ).toMatchObject({ allowed: true, reason: 'granted', assignmentId: 'a-cashier' });
  });

  it('denies out of scope, missing permission and exceeded limits with distinct reasons', () => {
    expect(can(cashier, 'orders.create', { kind: 'location', id: 'loc-9' }).reason).toBe(
      'out_of_scope',
    );
    expect(can(cashier, 'orders.void', { kind: 'location', id: 'loc-1' }).reason).toBe(
      'no_assignment',
    );
    expect(
      can(
        cashier,
        'orders.discount.apply',
        { kind: 'location', id: 'loc-1' },
        { attributes: { 'orders.discount.max_percent': 25 } },
      ),
    ).toMatchObject({
      allowed: false,
      reason: 'limit_exceeded',
      limit: {
        key: 'orders.discount.max_percent',
        value: 10,
        attribute: 25,
        assignmentId: 'a-cashier',
      },
    });
  });

  it('a tenant-scope assignment grants at any register', () => {
    const owner = principalWith({
      assignmentId: 'a-owner',
      role: 'tenant_owner',
      permissions: ['orders.void'],
      scope: { kind: 'tenant', id: 't1' },
      coveredScopeIds: [],
    });
    expect(can(owner, 'orders.void', { kind: 'register', id: 'reg-unknown' })).toMatchObject({
      allowed: true,
      assignmentId: 'a-owner',
    });
  });

  it('reports expired when validTo is in the past', () => {
    const elevated = principalWith({
      ...cashierAssignment,
      assignmentId: 'a-temp',
      permissions: ['orders.void'],
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2026-01-02T00:00:00.000Z',
    });
    const decision = can(
      elevated,
      'orders.void',
      { kind: 'register', id: 'reg-1' },
      { now: new Date('2026-01-03T00:00:00.000Z') },
    );
    expect(decision).toEqual({ allowed: false, reason: 'expired' });
    // Exactly at validTo the window is closed (half-open).
    expect(
      can(
        elevated,
        'orders.void',
        { kind: 'register', id: 'reg-1' },
        { now: new Date('2026-01-02T00:00:00.000Z') },
      ).reason,
    ).toBe('expired');
  });

  it('reports expired when validFrom is in the future', () => {
    const future = principalWith({
      ...cashierAssignment,
      assignmentId: 'a-future',
      validFrom: '2030-01-01T00:00:00.000Z',
    });
    expect(
      can(
        future,
        'orders.discount.apply',
        { kind: 'register', id: 'reg-1' },
        { now: new Date('2026-10-18T00:00:00.000Z') },
      ).reason,
    ).toBe('expired');
  });

  it('an expired assignment does not mask an active one', () => {
    const both = principalWith(
      { ...cashierAssignment, assignmentId: 'a-old', validTo: '2020-01-01T00:00:00.000Z' },
      cashierAssignment,
    );
    expect(can(both, 'orders.discount.apply', { kind: 'register', id: 'reg-2' })).toMatchObject({
      allowed: true,
      assignmentId: 'a-cashier',
    });
  });

  it('array limits: a category outside allowed_categories is limit_exceeded naming the key', () => {
    const manager = principalWith({
      assignmentId: 'a-mgr',
      role: 'store_manager',
      permissions: ['orders.price.override'],
      scope: { kind: 'location', id: 'loc-1' },
      coveredScopeIds: [],
      limits: { 'orders.price_override.allowed_categories': ['bakery', 'deli'] },
    });
    const scope = { kind: 'location', id: 'loc-1' } as const;
    const key = 'orders.price_override.allowed_categories';
    expect(
      can(manager, 'orders.price.override', scope, { attributes: { [key]: 'bakery' } }).allowed,
    ).toBe(true);
    expect(
      can(manager, 'orders.price.override', scope, { attributes: { [key]: 'alcohol' } }),
    ).toMatchObject({ reason: 'limit_exceeded', limit: { key, attribute: 'alcohol' } });
    expect(
      can(manager, 'orders.price.override', scope, { attributes: { [key]: ['bakery', 'deli'] } })
        .allowed,
    ).toBe(true);
    expect(
      can(manager, 'orders.price.override', scope, { attributes: { [key]: ['bakery', 'wine'] } })
        .reason,
    ).toBe('limit_exceeded');
  });

  it('boolean false forbids a truthy attribute; string limits require equality', () => {
    const p = principalWith({
      ...cashierAssignment,
      limits: { 'orders.refund.no_receipt': false, 'orders.tender.kind': 'cash' },
    });
    const scope = { kind: 'register', id: 'reg-1' } as const;
    expect(
      can(p, 'orders.discount.apply', scope, { attributes: { 'orders.refund.no_receipt': true } }),
    ).toMatchObject({ reason: 'limit_exceeded', limit: { key: 'orders.refund.no_receipt' } });
    expect(
      can(p, 'orders.discount.apply', scope, { attributes: { 'orders.refund.no_receipt': false } })
        .allowed,
    ).toBe(true);
    expect(
      can(p, 'orders.discount.apply', scope, { attributes: { 'orders.tender.kind': 'card' } })
        .reason,
    ).toBe('limit_exceeded');
    expect(
      can(p, 'orders.discount.apply', scope, { attributes: { 'orders.tender.kind': 'cash' } })
        .allowed,
    ).toBe(true);
  });

  it('a missing attribute is not evaluated', () => {
    expect(can(cashier, 'orders.discount.apply', { kind: 'register', id: 'reg-1' }).allowed).toBe(
      true,
    );
  });
});

describe('mergeLimits()', () => {
  it('assignment limits override role limits per key', () => {
    const merged = mergeLimits(
      { 'orders.discount.max_percent': 10, 'orders.refund.max_minor': 5000 },
      { 'orders.discount.max_percent': 25 },
    );
    expect(merged).toEqual({ 'orders.discount.max_percent': 25, 'orders.refund.max_minor': 5000 });

    const p = principalWith({ ...cashierAssignment, limits: merged });
    expect(
      can(
        p,
        'orders.discount.apply',
        { kind: 'register', id: 'reg-1' },
        { attributes: { 'orders.discount.max_percent': 20 } },
      ).allowed,
    ).toBe(true);
  });
});

describe('requiresMfa()', () => {
  it('is true for *.admin and finance.* keys', () => {
    expect(requiresMfa(['tenancy.location.view', 'config.admin'])).toBe(true);
    expect(requiresMfa(['finance.reports.view'])).toBe(true);
  });

  it('is false for a cashier permission set', () => {
    expect(requiresMfa(['orders.discount.apply', 'approvals.request', 'orders.create'])).toBe(
      false,
    );
    expect(requiresMfa([])).toBe(false);
  });
});
