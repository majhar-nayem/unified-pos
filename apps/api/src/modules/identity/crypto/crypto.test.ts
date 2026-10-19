import { describe, expect, it } from 'vitest';

import { PasswordHasher } from './password-hasher.js';
import { newEnrollmentCode, newRefreshToken, parseRefreshToken, sha256Hex } from './random.js';
import { SecretBox } from './secret-box.js';
import { TokenService } from './tokens.js';

const TENANT = '0190f8a0-0000-7000-8000-00000000000a';

describe('PasswordHasher', () => {
  it('round-trips and rejects wrong secrets, including missing hashes', async () => {
    const hasher = new PasswordHasher();
    const hash = await hasher.hash('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await hasher.verify(hash, 'correct horse battery staple')).toBe(true);
    expect(await hasher.verify(hash, 'wrong')).toBe(false);
    expect(await hasher.verify(null, 'anything')).toBe(false);
  });
});

describe('SecretBox', () => {
  it('seals with AAD and rejects tampering or the wrong owner', () => {
    const box = new SecretBox({ AUTH_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64') });
    const sealed = box.seal('JBSWY3DPEHPK3PXP', 'user-1');
    expect(sealed.startsWith('v1.k1.')).toBe(true);
    expect(box.open(sealed, 'user-1')).toBe('JBSWY3DPEHPK3PXP');
    expect(() => box.open(sealed, 'user-2')).toThrow();
    const [v, kid, iv, ct, tag] = sealed.split('.');
    const flipped = tag!.endsWith('A') ? tag!.replace(/.$/, 'B') : tag!.replace(/.$/, 'A');
    expect(() => box.open([v, kid, iv, ct, flipped].join('.'), 'user-1')).toThrow();
    expect(() => new SecretBox({ AUTH_SECRETS_KEY: 'short' })).toThrow(/32 bytes/);
    expect(() => new SecretBox({ NODE_ENV: 'production' })).toThrow(/required/);
  });
});

describe('TokenService', () => {
  it('signs and verifies, enforcing kind, expiry and known key ids', async () => {
    const service = await TokenService.fromEnv({});
    const { token, claims } = await service.sign({
      sub: 'u1',
      tid: TENANT,
      knd: 'web',
      sid: 's1',
      amr: ['pwd'],
      mfa: false,
      av: 3,
    });
    const verified = await service.verify(token);
    expect(verified).toMatchObject({
      sub: 'u1',
      tid: TENANT,
      knd: 'web',
      sid: 's1',
      av: 3,
      jti: claims.jti,
    });
    await expect(service.verify(token, { kinds: ['device'] })).rejects.toMatchObject({
      code: 'TOKEN_KIND_NOT_ALLOWED',
    });
    const expired = await service.sign(
      { sub: 'u1', tid: TENANT, knd: 'web', amr: [], mfa: false, av: 0 },
      -120,
    );
    await expect(service.verify(expired.token)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    const other = await TokenService.fromEnv({});
    await expect(other.verify(token)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    expect(service.jwks().keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA' });
    expect(() => TokenService.fromEnv({ NODE_ENV: 'production' })).rejects.toThrow(/required/);
  });
});

describe('random tokens', () => {
  it('refresh tokens carry the tenant id and hash deterministically', () => {
    const token = newRefreshToken(TENANT);
    expect(parseRefreshToken(token)).toEqual({ tenantId: TENANT, hash: sha256Hex(token) });
    expect(parseRefreshToken('nope')).toBeNull();
    expect(newEnrollmentCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
  });
});
