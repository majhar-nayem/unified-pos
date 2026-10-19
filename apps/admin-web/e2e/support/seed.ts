import { randomUUID } from 'node:crypto';

import type { BrowserContext, Page } from '@playwright/test';
import { URI } from 'otpauth';

export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3100';
export const OPERATOR_TOKEN = process.env.E2E_OPERATOR_TOKEN ?? 'op_f8_local_operator_token_0001';
export const PASSWORD = 'correct horse battery staple';

export interface Tokens {
  accessToken: string;
  refreshToken?: string;
}

export async function call<T = unknown>(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; expect?: number | number[]; ifMatch?: number } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
  if (method === 'POST') headers['idempotency-key'] = randomUUID();
  const res = await fetch(`${API_URL}/v1${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  const body = (text ? JSON.parse(text) : null) as T;
  const expected = options.expect === undefined ? [200, 201, 204] : [options.expect].flat();
  if (!expected.includes(res.status)) {
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return { status: res.status, body };
}

/** A TOTP generator for a secret: `offset` steps from now (the API accepts ±1 and each step once). */
export function totpFor(otpauthUri: string) {
  const totp = URI.parse(otpauthUri) as {
    generate(o?: { timestamp?: number }): string;
    secret: { base32: string };
  };
  return {
    secret: totp.secret.base32,
    code: (offsetSteps = 0) => totp.generate({ timestamp: Date.now() + offsetSteps * 30_000 }),
  };
}

export interface Tenant {
  slug: string;
  name: string;
  tenantId: string;
  rootOrgUnitId: string;
  ownerEmail: string;
  ownerId: string;
  ownerToken: string;
  ownerTokens: Tokens;
  totp: ReturnType<typeof totpFor> | null;
  /** Calls the API as the owner. The seed used TOTP step -1, so the UI may use steps 0 and +1. */
  api<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    extra?: { expect?: number | number[]; ifMatch?: number },
  ): Promise<{ status: number; body: T }>;
}

export interface ProvisionOptions {
  /** Enrol TOTP and sign the owner in through the API (default). Leave the owner un-enrolled when false. */
  enrolOwner?: boolean;
}

export async function provisionTenant(options: ProvisionOptions = {}): Promise<Tenant> {
  const enrolOwner = options.enrolOwner ?? true;
  const slug = `f8-${randomUUID().slice(0, 8)}`;
  const ownerEmail = `owner@${slug}.test`;
  const { body } = await call<{
    tenant: { id: string };
    rootOrgUnitId: string;
    admin: { userId: string; inviteToken: string };
  }>('POST', '/tenants', {
    token: OPERATOR_TOKEN,
    body: { slug, name: `E2E ${slug}`, admin: { email: ownerEmail, displayName: 'Olive Owner' } },
  });
  await call('POST', '/users/accept-invite', {
    body: { token: body.admin.inviteToken, password: PASSWORD },
  });
  const tenant: Tenant = {
    slug,
    name: `E2E ${slug}`,
    tenantId: body.tenant.id,
    rootOrgUnitId: body.rootOrgUnitId,
    ownerEmail,
    ownerId: body.admin.userId,
    ownerToken: '',
    ownerTokens: { accessToken: '' },
    totp: null,
    api: (method, path, body, extra = {}) =>
      call(method, path, {
        token: tenant.ownerToken,
        ...(body === undefined ? {} : { body }),
        ...extra,
      }),
  };
  if (!enrolOwner) return tenant;

  const first = await call<{ status: string; preauthToken: string }>('POST', '/auth/login', {
    body: { tenantSlug: slug, email: ownerEmail, password: PASSWORD },
  });
  const preauth = first.body.preauthToken;
  const enrol = await call<{ otpauthUri: string }>('POST', '/users/me/totp/enroll', {
    token: preauth,
  });
  const totp = totpFor(enrol.body.otpauthUri);
  await call('POST', '/users/me/totp/confirm', { token: preauth, body: { code: totp.code(-1) } });
  const second = await call<{ preauthToken: string }>('POST', '/auth/login', {
    body: { tenantSlug: slug, email: ownerEmail, password: PASSWORD },
  });
  const verified = await call<{ tokens: Tokens }>('POST', '/auth/mfa/totp', {
    token: second.body.preauthToken,
    body: { code: totp.code(-1) },
  });
  tenant.totp = totp;
  tenant.ownerTokens = verified.body.tokens;
  tenant.ownerToken = verified.body.tokens.accessToken;
  return tenant;
}

export async function createLocation(t: Tenant, name: string, code: string) {
  const res = await t.api<{ id: string; name: string }>('POST', '/locations', {
    orgUnitId: t.rootOrgUnitId,
    code,
    name,
    kind: 'store',
    timezone: 'Australia/Sydney',
    currency: 'AUD',
  });
  return res.body;
}

export async function roleId(t: Tenant, key: string): Promise<string> {
  const roles = await t.api<{ id: string; key: string }[]>('GET', '/roles');
  const found = roles.body.find((r) => r.key === key);
  if (!found) throw new Error(`role ${key} not found`);
  return found.id;
}

export interface SeedUser {
  id: string;
  email: string;
  name: string;
  tokens: Tokens;
}

/** Creates a user with a password, optionally grants a role at a scope, and signs them in (no MFA roles only). */
export async function createStaff(
  t: Tenant,
  name: string,
  grant?: { role: string; scope: { kind: string; id: string }; limits?: Record<string, number> },
): Promise<SeedUser> {
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}@${t.slug}.test`;
  const created = await t.api<{ id: string }>('POST', '/users', {
    email,
    displayName: name,
    password: PASSWORD,
  });
  if (grant) {
    await t.api('POST', '/role-assignments', {
      userId: created.body.id,
      roleId: await roleId(t, grant.role),
      scope: grant.scope,
      ...(grant.limits ? { limits: grant.limits } : {}),
    });
  }
  let tokens: Tokens = { accessToken: '' };
  if (grant && !['tenant_owner', 'admin', 'finance'].includes(grant.role)) {
    const login = await call<{ status: string; tokens: Tokens }>('POST', '/auth/login', {
      body: { tenantSlug: t.slug, email, password: PASSWORD },
    });
    tokens = login.body.tokens;
  }
  return { id: created.body.id, email, name, tokens };
}

export async function createApproval(user: SeedUser, locationId: string, percent = 25) {
  const res = await call<{ id: string }>('POST', '/approvals', {
    token: user.tokens.accessToken,
    body: {
      kind: 'discount_over_limit',
      locationId,
      subjectKind: 'order_line',
      payload: {
        permission: 'orders.discount.apply',
        attributes: { 'orders.discount.max_percent': percent },
      },
    },
  });
  return res.body;
}

/** Signs a browser context in by planting the session cookies the console would have set. */
export async function signIn(
  context: BrowserContext,
  tokens: Tokens,
  baseURL = `http://localhost:${process.env.E2E_WEB_PORT ?? 3101}`,
): Promise<void> {
  const url = new URL(baseURL);
  const common = {
    domain: url.hostname,
    path: '/',
    httpOnly: true,
    sameSite: 'Lax' as const,
    secure: false,
  };
  await context.addCookies([
    { ...common, name: 'pos_at', value: tokens.accessToken },
    ...(tokens.refreshToken ? [{ ...common, name: 'pos_rt', value: tokens.refreshToken }] : []),
  ]);
}

export async function gotoAs(page: Page, tokens: Tokens, path: string): Promise<void> {
  await signIn(page.context(), tokens);
  await page.goto(path);
}
