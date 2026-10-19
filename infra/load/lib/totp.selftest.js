// k6 run infra/load/lib/totp.selftest.js
// RFC 6238 Appendix B, SHA-1: secret "12345678901234567890", T = 59 s → 94287082 (8 digits), 1111111109 → 07081804.
import { check } from 'k6';

import { totp } from './totp.js';

export const options = { vus: 1, iterations: 1, thresholds: { checks: ['rate==1'] } };

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

export default function () {
  check(null, {
    'RFC 6238 vector at t=59 (8 digits)': () => totp(SECRET, 0, 59000, 8) === '94287082',
    'RFC 6238 vector at t=1111111109 (8 digits)': () =>
      totp(SECRET, 0, 1111111109000, 8) === '07081804',
    'RFC 6238 vector at t=2000000000 (8 digits)': () =>
      totp(SECRET, 0, 2000000000000, 8) === '69279037',
    'six digit code is the last six of the eight': () => totp(SECRET, 0, 59000) === '287082',
    'offset steps move the window': () => totp(SECRET, 1, 29000) === totp(SECRET, 0, 59000),
  });
}
