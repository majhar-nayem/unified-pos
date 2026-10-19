import { cookies } from 'next/headers';
import type { NextResponse } from 'next/server';

/** Base URL of apps/api (no /v1 suffix). */
export const API_URL = (process.env.POS_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
export const API_V1 = `${API_URL}/v1`;

export const COOKIE_ACCESS = 'pos_at';
export const COOKIE_REFRESH = 'pos_rt';
export const COOKIE_PREAUTH = 'pos_pre';

/** Secure cookies in production; set POS_COOKIE_SECURE=false for plain-http staging or compose runs. */
const secure = process.env.POS_COOKIE_SECURE
  ? process.env.POS_COOKIE_SECURE !== 'false'
  : process.env.NODE_ENV === 'production';
const base = { httpOnly: true, sameSite: 'lax' as const, secure, path: '/' };

export interface TokenPairLike {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}

/** Refresh tokens slide for 12 h (docs/releases/f1.md); the cookie follows. */
const REFRESH_MAX_AGE_SECONDS = 12 * 60 * 60;
const PREAUTH_MAX_AGE_SECONDS = 5 * 60;

export function setSessionCookies(res: NextResponse, tokens: TokenPairLike): void {
  res.cookies.set(COOKIE_ACCESS, tokens.accessToken, { ...base, maxAge: tokens.expiresIn });
  if (tokens.refreshToken) {
    res.cookies.set(COOKIE_REFRESH, tokens.refreshToken, {
      ...base,
      maxAge: REFRESH_MAX_AGE_SECONDS,
    });
  }
  res.cookies.set(COOKIE_PREAUTH, '', { ...base, maxAge: 0 });
}

export function setPreauthCookie(res: NextResponse, preauthToken: string): void {
  res.cookies.set(COOKIE_PREAUTH, preauthToken, { ...base, maxAge: PREAUTH_MAX_AGE_SECONDS });
}

export function clearSessionCookies(res: NextResponse): void {
  for (const name of [COOKIE_ACCESS, COOKIE_REFRESH, COOKIE_PREAUTH]) {
    res.cookies.set(name, '', { ...base, maxAge: 0 });
  }
}

export async function readCookie(name: string): Promise<string | undefined> {
  const store = await cookies();
  return store.get(name)?.value;
}

export interface UpstreamResult {
  status: number;
  body: unknown;
  headers: Headers;
}

/** JSON call to the API from the server side. */
export async function upstream(
  path: string,
  init: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<UpstreamResult> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  const res = await fetch(`${API_V1}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: 'no-store',
    redirect: 'manual',
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: { code: 'UPSTREAM_INVALID', message: text.slice(0, 200) } };
    }
  }
  return { status: res.status, body, headers: res.headers };
}

export function unavailable(): { status: number; body: unknown } {
  return {
    status: 503,
    body: { error: { code: 'API_UNAVAILABLE', message: 'The API is not reachable' } },
  };
}
