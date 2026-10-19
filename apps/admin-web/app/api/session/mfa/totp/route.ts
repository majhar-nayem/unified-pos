import type { NextResponse } from 'next/server';

import { completeSecondFactor } from '@/lib/server/mfa';

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as unknown;
  return completeSecondFactor('/auth/mfa/totp', body);
}
