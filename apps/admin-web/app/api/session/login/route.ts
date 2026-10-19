import { NextResponse } from 'next/server';

import { setPreauthCookie, setSessionCookies, unavailable, upstream } from '@/lib/server/api';

interface LoginUpstream {
  status: 'authenticated' | 'mfa_required' | 'mfa_enrollment_required';
  tokens?: { accessToken: string; refreshToken?: string; expiresIn: number };
  preauthToken?: string;
  methods?: string[];
}

/** Password step: tokens never reach the browser; the response only says what comes next. */
export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as unknown;
  let result;
  try {
    result = await upstream('/auth/login', { method: 'POST', body });
  } catch {
    const u = unavailable();
    return NextResponse.json(u.body, { status: u.status });
  }
  if (result.status !== 200) return NextResponse.json(result.body, { status: result.status });
  const data = result.body as LoginUpstream;
  if (data.status === 'authenticated' && data.tokens) {
    const res = NextResponse.json({ status: 'authenticated' });
    setSessionCookies(res, data.tokens);
    return res;
  }
  if (data.preauthToken) {
    const res = NextResponse.json({ status: data.status, methods: data.methods ?? [] });
    setPreauthCookie(res, data.preauthToken);
    return res;
  }
  return NextResponse.json(
    { error: { code: 'LOGIN_UNEXPECTED', message: 'Unexpected login response' } },
    { status: 502 },
  );
}
