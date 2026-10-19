'use client';

import type { Assignment, Decision, PermissionKey, Principal, Scope } from '@pos/auth';
import { can } from '@pos/auth';
import type { PrincipalDto, TenantDto, UserDto } from '@pos/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { ApiError, UNAUTHENTICATED_EVENT, api, sessionCall } from '@/lib/api/client';

export type SessionStatus = 'loading' | 'authenticated' | 'anonymous';

export interface Session {
  status: SessionStatus;
  principal: PrincipalDto | null;
  tenant: TenantDto | null;
  user: UserDto | null;
  error: string | null;
  reload(): Promise<void>;
  logout(): Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

async function loadSession(): Promise<Pick<Session, 'principal' | 'tenant' | 'user'>> {
  const principal = await api<PrincipalDto>('/auth/me');
  const [tenant, user] = await Promise.all([
    api<TenantDto>('/tenants/me').catch((e: unknown) => {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return null;
      throw e;
    }),
    api<UserDto>('/users/me').catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 401) throw e;
      return null;
    }),
  ]);
  return { principal, tenant, user };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<Session, 'reload' | 'logout'>>({
    status: 'loading',
    principal: null,
    tenant: null,
    user: null,
    error: null,
  });
  const queryClient = useQueryClient();

  const reload = useCallback(async () => {
    try {
      const loaded = await loadSession();
      setState({ status: 'authenticated', error: null, ...loaded });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setState({ status: 'anonymous', principal: null, tenant: null, user: null, error: null });
      } else {
        setState((prev) => ({
          ...prev,
          status: prev.principal ? prev.status : 'anonymous',
          error: error instanceof Error ? error.message : 'Could not load the session',
        }));
      }
    }
  }, []);

  const logout = useCallback(async () => {
    await sessionCall('/logout').catch(() => undefined);
    queryClient.clear();
    setState({ status: 'anonymous', principal: null, tenant: null, user: null, error: null });
  }, [queryClient]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const onUnauthenticated = () => {
      queryClient.clear();
      setState({ status: 'anonymous', principal: null, tenant: null, user: null, error: null });
    };
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
  }, [queryClient]);

  const value = useMemo<Session>(() => ({ ...state, reload, logout }), [state, reload, logout]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** Supplies a ready-made session value (component tests, storybook-style fixtures). */
export function SessionValueProvider({ value, children }: { value: Session; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}

/** Redirects anonymous visitors to the login page, remembering where they were going. */
export function useRequireSession(): Session {
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (session.status === 'anonymous') {
      const next = pathname && pathname !== '/login' ? `?next=${encodeURIComponent(pathname)}` : '';
      router.replace(`/login${next}`);
    }
  }, [session.status, router, pathname]);
  return session;
}

export function toPrincipal(dto: PrincipalDto): Principal {
  return {
    tenantId: dto.tenantId,
    subjectId: dto.subjectId,
    kind: dto.kind,
    ...(dto.sessionId ? { sessionId: dto.sessionId } : {}),
    ...(dto.deviceId ? { deviceId: dto.deviceId } : {}),
    ...(dto.locationId ? { locationId: dto.locationId } : {}),
    mfaVerified: dto.mfaVerified,
    assignmentsVersion: dto.assignmentsVersion,
    assignments: dto.assignments.map((a): Assignment => ({
      assignmentId: a.assignmentId,
      role: a.role,
      permissions: a.permissions as PermissionKey[],
      scope: a.scope,
      coveredScopeIds: a.coveredScopeIds,
      ...(a.validFrom ? { validFrom: a.validFrom } : {}),
      ...(a.validTo ? { validTo: a.validTo } : {}),
      ...(a.limits ? { limits: a.limits } : {}),
    })),
  };
}

export interface Permissions {
  /** True when some active assignment grants the key anywhere in the tenant (the server's `assertAnywhere`). */
  has(key: PermissionKey): boolean;
  /** Full policy decision at a scope, using the same evaluator as the API (@pos/auth). */
  canAt(
    key: PermissionKey,
    scope: Scope,
    attributes?: Record<string, number | string | boolean | readonly string[]>,
  ): Decision;
  /** Convenience: decision at the tenant scope (tenant-level resources). */
  canTenant(key: PermissionKey): boolean;
  principal: Principal | null;
  tenantId: string | null;
}

const DENIED: Decision = { allowed: false, reason: 'no_assignment' };

export function usePermissions(): Permissions {
  const { principal: dto } = useSession();
  return useMemo<Permissions>(() => {
    const principal = dto ? toPrincipal(dto) : null;
    const tenantId = dto?.tenantId ?? null;
    const granted = new Set(dto?.permissions ?? []);
    const now = new Date();
    return {
      principal,
      tenantId,
      has: (key) => {
        if (!principal || !granted.has(key)) return false;
        // Assignment windows: the union on the DTO ignores validity, the evaluator does not.
        return principal.assignments.some(
          (a) =>
            a.permissions.includes(key) &&
            can({ ...principal, assignments: [a] }, key, a.scope, { now }).allowed,
        );
      },
      canAt: (key, scope, attributes) =>
        principal ? can(principal, key, scope, attributes ? { attributes } : {}) : DENIED,
      canTenant: (key) =>
        principal && tenantId
          ? can(principal, key, { kind: 'tenant', id: tenantId }).allowed
          : false,
    };
  }, [dto]);
}
