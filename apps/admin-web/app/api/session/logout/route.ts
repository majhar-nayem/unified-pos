import { NextResponse } from 'next/server';

import { COOKIE_ACCESS, clearSessionCookies, readCookie, upstream } from '@/lib/server/api';

export async function POST(): Promise<NextResponse> {
  const token = await readCookie(COOKIE_ACCESS);
  if (token) {
    await upstream('/auth/logout', { method: 'POST', token }).catch(() => undefined);
  }
  const res = new NextResponse(null, { status: 204 });
  clearSessionCookies(res);
  return res;
}
