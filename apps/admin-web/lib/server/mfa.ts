import { NextResponse } from 'next/server';

import {
  COOKIE_ACCESS,
  COOKIE_PREAUTH,
  readCookie,
  setSessionCookies,
  unavailable,
  upstream,
} from './api';

/**
 * Second-factor completion shared by TOTP and passkey verification: the preauth token (or an
 * existing web session for step-up) comes from the cookie, a full session comes back as cookies.
 */
export async function completeSecondFactor(path: string, body: unknown): Promise<NextResponse> {
  const token = (await readCookie(COOKIE_PREAUTH)) ?? (await readCookie(COOKIE_ACCESS));
  if (!token) {
    return NextResponse.json(
      { error: { code: 'PREAUTH_MISSING', message: 'Start again from the password step' } },
      { status: 401 },
    );
  }
  let result;
  try {
    result = await upstream(path, { method: 'POST', token, body });
  } catch {
    const u = unavailable();
    return NextResponse.json(u.body, { status: u.status });
  }
  if (result.status !== 200) return NextResponse.json(result.body, { status: result.status });
  const data = result.body as {
    status: string;
    tokens?: { accessToken: string; refreshToken?: string; expiresIn: number };
  };
  if (data.status === 'authenticated' && data.tokens) {
    const res = NextResponse.json({ status: 'authenticated' });
    setSessionCookies(res, data.tokens);
    return res;
  }
  return NextResponse.json(data, { status: 200 });
}

/** Calls the API with the preauth (or web) token and relays the JSON body unchanged. */
export async function withPreauth(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<NextResponse> {
  const token = (await readCookie(COOKIE_PREAUTH)) ?? (await readCookie(COOKIE_ACCESS));
  if (!token) {
    return NextResponse.json(
      { error: { code: 'PREAUTH_MISSING', message: 'Start again from the password step' } },
      { status: 401 },
    );
  }
  try {
    const result = await upstream(path, { method: init.method ?? 'POST', token, body: init.body });
    if (result.status === 204) return new NextResponse(null, { status: 204 });
    return NextResponse.json(result.body, { status: result.status });
  } catch {
    const u = unavailable();
    return NextResponse.json(u.body, { status: u.status });
  }
}
