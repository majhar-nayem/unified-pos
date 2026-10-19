import { type NextRequest, NextResponse } from 'next/server';

import {
  API_V1,
  COOKIE_ACCESS,
  COOKIE_REFRESH,
  clearSessionCookies,
  readCookie,
  setSessionCookies,
} from '@/lib/server/api';

const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'idempotency-key', 'if-match'];
const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'etag',
  'idempotency-replayed',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'retry-after',
];

/**
 * Same-origin proxy to the API: attaches the access token from the httpOnly cookie, rotates the
 * refresh token once on 401 and retries, and relays status, body and the headers the UI uses
 * (ETag for If-Match, Idempotency-Replayed).
 */
async function proxy(req: NextRequest, path: string[]): Promise<NextResponse> {
  // A dot segment would let a crafted URL climb out of /v1 on the API host.
  if (path.some((segment) => segment === '.' || segment === '..' || segment === '')) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'Not found' } },
      { status: 404 },
    );
  }
  const target = new URL(`${API_V1}/${path.map(encodeURIComponent).join('/')}`);
  target.search = req.nextUrl.search;
  const access = await readCookie(COOKIE_ACCESS);
  const refresh = await readCookie(COOKIE_REFRESH);
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();

  const send = async (token: string | undefined): Promise<Response> => {
    const headers = new Headers();
    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = req.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (token) headers.set('authorization', `Bearer ${token}`);
    return fetch(target, {
      method: req.method,
      headers,
      body: body && body.length > 0 ? body : undefined,
      cache: 'no-store',
      redirect: 'manual',
    });
  };

  let upstream: Response;
  try {
    upstream = await send(access);
  } catch {
    return NextResponse.json(
      { error: { code: 'API_UNAVAILABLE', message: 'The API is not reachable' } },
      { status: 503 },
    );
  }

  let rotated: { accessToken: string; refreshToken?: string; expiresIn: number } | undefined;
  if (upstream.status === 401 && refresh) {
    const r = await fetch(`${API_V1}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ refreshToken: refresh }),
      cache: 'no-store',
    }).catch(() => undefined);
    if (r?.ok) {
      rotated = (await r.json()) as typeof rotated;
      upstream = await send(rotated?.accessToken);
    } else {
      const res = NextResponse.json(
        { error: { code: 'SESSION_EXPIRED', message: 'Sign in again' } },
        { status: 401 },
      );
      clearSessionCookies(res);
      return res;
    }
  }

  const headers = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  const text = await upstream.text();
  const res = new NextResponse(upstream.status === 204 || text.length === 0 ? null : text, {
    status: upstream.status,
    headers,
  });
  if (rotated) setSessionCookies(res, rotated);
  return res;
}

type Ctx = { params: Promise<{ path: string[] }> };
const handler = async (req: NextRequest, ctx: Ctx) => proxy(req, (await ctx.params).path);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
