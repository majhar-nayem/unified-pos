import { describe, expect, it } from 'vitest';

import { verifyTotpCode } from './totp.service.js';

// RFC 6238 Appendix B uses the SHA-1 seed "12345678901234567890" (base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ)
const SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('verifyTotpCode (RFC 6238, SHA-1, 30 s, 6 digits)', () => {
  it('accepts the published vectors (8-digit values truncated to 6)', () => {
    // T = 59 s → 94287082 → "287082"; T = 1111111109 → 07081804 → "081804"
    expect(verifyTotpCode(SEED, '287082', 59_000)).toBe(1);
    expect(verifyTotpCode(SEED, '081804', 1_111_111_109_000)).toBe(37037036);
  });

  it('tolerates one step of drift and rejects more', () => {
    expect(verifyTotpCode(SEED, '287082', 59_000 + 30_000)).toBe(1);
    expect(verifyTotpCode(SEED, '287082', 59_000 + 61_000)).toBeNull();
    expect(verifyTotpCode(SEED, '000000', 59_000)).toBeNull();
  });
});
