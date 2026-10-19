import type { NextResponse } from 'next/server';

import { withPreauth } from '@/lib/server/mfa';

/** TOTP enrolment with a preauth token (mfa_enrollment_required) or inside a web session. */
export async function POST(): Promise<NextResponse> {
  return withPreauth('/users/me/totp/enroll');
}
