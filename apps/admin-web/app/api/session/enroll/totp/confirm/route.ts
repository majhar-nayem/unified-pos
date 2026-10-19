import type { NextResponse } from 'next/server';

import { withPreauth } from '@/lib/server/mfa';

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as unknown;
  return withPreauth('/users/me/totp/confirm', { body });
}
