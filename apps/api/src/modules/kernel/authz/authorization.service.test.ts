import type { Principal } from '@pos/auth';
import { describe, expect, it } from 'vitest';

import type { AuthenticatedPrincipal } from '../auth/authenticator.js';
import { ForbiddenError, LimitExceededError, NotFoundError } from '../errors/errors.js';
import { KernelPorts } from '../ports.js';
import { RequestContextService, type ResolvedScope } from '../request-context.js';
import { AuthorizationService } from './authorization.service.js';

const T = '0190f8a0-0000-7000-8000-00000000000a';
const LOC_A = '0190f8a0-0000-7000-8000-00000000000b';
const LOC_B = '0190f8a0-0000-7000-8000-00000000000c';
const REG_A = '0190f8a0-0000-7000-8000-00000000000d';

const paths: Record<string, ResolvedScope> = {
  [REG_A]: {
    kind: 'register',
    id: REG_A,
    path: [
      { kind: 'register', id: REG_A },
      { kind: 'location', id: LOC_A },
      { kind: 'tenant', id: T },
    ],
  },
  [LOC_A]: {
    kind: 'location',
    id: LOC_A,
    path: [
      { kind: 'location', id: LOC_A },
      { kind: 'tenant', id: T },
    ],
  },
  [LOC_B]: {
    kind: 'location',
    id: LOC_B,
    path: [
      { kind: 'location', id: LOC_B },
      { kind: 'tenant', id: T },
    ],
  },
};

const cashier: Principal = {
  tenantId: T,
  subjectId: 'u1',
  kind: 'user',
  mfaVerified: false,
  assignmentsVersion: 1,
  assignments: [
    {
      assignmentId: 'a1',
      role: 'cashier',
      permissions: ['orders.discount.apply'],
      scope: { kind: 'location', id: LOC_A },
      coveredScopeIds: [],
      limits: { 'orders.discount.max_percent': 10 },
    },
  ],
};

function service(principal: AuthenticatedPrincipal) {
  const context = new RequestContextService();
  const resolver = {
    resolve: async (_t: string, _k: string, id: string) => paths[id] ?? null,
    expand: async () => null,
  };
  const ports = new KernelPorts();
  ports.bind({ scopeResolver: resolver });
  const authz = new AuthorizationService(context, ports);
  const run = <R>(fn: () => Promise<R>) =>
    context.run({ correlationId: 'c', startedAt: 0, principal, tenantId: T }, fn);
  return { authz, run };
}

describe('AuthorizationService', () => {
  const user: AuthenticatedPrincipal = { ...cashier, tokenKind: 'pos' };

  it("grants through an ancestor assignment (register under the cashier's location)", async () => {
    const { authz, run } = service(user);
    const decision = await run(() =>
      authz.can(
        'orders.discount.apply',
        { kind: 'register', id: REG_A },
        { 'orders.discount.max_percent': 5 },
      ),
    );
    expect(decision).toMatchObject({ allowed: true, assignmentId: 'a1' });
  });

  it('maps out_of_scope to 404, missing permission to 403 and exceeded limits to LimitExceededError', async () => {
    const { authz, run } = service(user);
    await expect(
      run(() => authz.assert('orders.discount.apply', { kind: 'location', id: LOC_B })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      run(() => authz.assert('orders.void', { kind: 'location', id: LOC_A })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      run(() =>
        authz.assert(
          'orders.discount.apply',
          { kind: 'location', id: LOC_A },
          { 'orders.discount.max_percent': 25 },
        ),
      ),
    ).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
      limit: { key: 'orders.discount.max_percent', value: 10, attribute: 25 },
    });
    await expect(
      run(() =>
        authz.assert(
          'orders.discount.apply',
          { kind: 'location', id: LOC_A },
          { 'orders.discount.max_percent': 25 },
        ),
      ),
    ).rejects.toBeInstanceOf(LimitExceededError);
  });

  it('unknown scope ids are out of scope (404), and operators are always granted', async () => {
    const { authz, run } = service(user);
    await expect(
      run(() =>
        authz.assert('orders.discount.apply', {
          kind: 'location',
          id: '0190f8a0-0000-7000-8000-0000000000ff',
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    const op = service({ kind: 'operator', operatorId: 'op', tenantId: null });
    expect((await op.run(() => op.authz.can('tenancy.admin'))).allowed).toBe(true);
  });
});
