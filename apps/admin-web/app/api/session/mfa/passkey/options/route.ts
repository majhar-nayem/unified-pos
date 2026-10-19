import type { NextResponse } from 'next/server';

import { withPreauth } from '@/lib/server/mfa';

export async function POST(): Promise<NextResponse> {
  return withPreauth('/auth/mfa/passkey/options');
}
