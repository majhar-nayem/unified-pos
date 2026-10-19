import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { AccessTokenClaims, TokenKind } from '@pos/auth';
import { createLogger } from '@pos/observability';
import {
  type CryptoKey,
  type JSONWebKeySet,
  type JWK,
  SignJWT,
  exportJWK,
  generateKeyPair,
  importJWK,
  importPKCS8,
  jwtVerify,
} from 'jose';

import { UnauthorizedError } from '../../kernel/public/index.js';

export const TOKEN_ISSUER = 'pos-api';
export const TOKEN_AUDIENCE = 'pos';
const ALG = 'EdDSA';

/** Lifetimes per token kind (docs/releases/f1.md). */
export const TOKEN_TTL_SECONDS: Readonly<Record<TokenKind, number>> = {
  web: 15 * 60,
  pos: 60 * 60,
  device: 24 * 60 * 60,
  api: 30 * 60,
  preauth: 5 * 60,
};

export type SignInput = Omit<AccessTokenClaims, 'iss' | 'aud' | 'jti' | 'iat' | 'exp'>;

/**
 * Issues and verifies the platform's own JWTs (EdDSA / Ed25519). Keys come from
 * AUTH_JWT_PRIVATE_KEY (base64 PKCS8 PEM) + AUTH_JWT_KID, with AUTH_JWT_PUBLIC_JWKS listing current and
 * previous public keys for rotation. Outside production an ephemeral key pair is generated at boot.
 */
@Injectable()
export class TokenService {
  private constructor(
    private readonly privateKey: CryptoKey,
    private readonly kid: string,
    private readonly publicKeys: Map<string, CryptoKey>,
    private readonly jwksDocument: JSONWebKeySet,
  ) {}

  static async fromEnv(env: NodeJS.ProcessEnv = process.env): Promise<TokenService> {
    const pem = env.AUTH_JWT_PRIVATE_KEY
      ? Buffer.from(env.AUTH_JWT_PRIVATE_KEY, 'base64').toString('utf8')
      : undefined;
    if (!pem) {
      if (env.NODE_ENV === 'production')
        throw new Error('AUTH_JWT_PRIVATE_KEY is required in production');
      createLogger({ service: 'identity.tokens' }).warn(
        'AUTH_JWT_PRIVATE_KEY unset: using an ephemeral signing key (tokens will not survive a restart)',
      );
      const pair = await generateKeyPair(ALG, { extractable: true });
      const kid = `ephemeral-${randomUUID().slice(0, 8)}`;
      const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: ALG, use: 'sig' };
      return new TokenService(pair.privateKey, kid, new Map([[kid, pair.publicKey]]), {
        keys: [jwk],
      });
    }
    const kid = env.AUTH_JWT_KID ?? 'k1';
    const privateKey = await importPKCS8(pem, ALG);
    const jwks: JSONWebKeySet = env.AUTH_JWT_PUBLIC_JWKS
      ? (JSON.parse(env.AUTH_JWT_PUBLIC_JWKS) as JSONWebKeySet)
      : { keys: [] };
    const publicKeys = new Map<string, CryptoKey>();
    for (const jwk of jwks.keys) {
      if (jwk.kid) publicKeys.set(jwk.kid, (await importJWK(jwk as JWK, ALG)) as CryptoKey);
    }
    if (!publicKeys.has(kid))
      throw new Error(`AUTH_JWT_PUBLIC_JWKS must contain the current key id "${kid}"`);
    return new TokenService(privateKey, kid, publicKeys, jwks);
  }

  async sign(
    input: SignInput,
    ttlSeconds = TOKEN_TTL_SECONDS[input.knd],
  ): Promise<{ token: string; claims: AccessTokenClaims; expiresIn: number }> {
    const now = Math.floor(Date.now() / 1000);
    const claims: AccessTokenClaims = {
      ...input,
      iss: TOKEN_ISSUER,
      aud: TOKEN_AUDIENCE,
      jti: randomUUID(),
      iat: now,
      exp: now + ttlSeconds,
    };
    const { iss, aud, jti, iat, exp, sub, ...rest } = claims;
    const token = await new SignJWT({ ...rest })
      .setProtectedHeader({ alg: ALG, kid: this.kid, typ: 'JWT' })
      .setIssuer(iss)
      .setAudience(aud)
      .setJti(jti)
      .setSubject(sub)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.privateKey);
    return { token, claims, expiresIn: ttlSeconds };
  }

  /** Verify signature, issuer, audience, expiry (60 s tolerance) and optionally the token kind. */
  async verify(
    token: string,
    options: { kinds?: readonly TokenKind[] } = {},
  ): Promise<AccessTokenClaims> {
    let payload: Record<string, unknown>;
    try {
      const result = await jwtVerify(
        token,
        async (header) => {
          const key = header.kid ? this.publicKeys.get(header.kid) : undefined;
          if (!key) throw new Error(`unknown kid ${header.kid}`);
          return key;
        },
        { issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE, algorithms: [ALG], clockTolerance: 60 },
      );
      payload = result.payload as Record<string, unknown>;
    } catch {
      throw new UnauthorizedError('TOKEN_INVALID', 'The token is invalid or expired');
    }
    const claims = payload as unknown as AccessTokenClaims;
    if (
      typeof claims.tid !== 'string' ||
      typeof claims.knd !== 'string' ||
      typeof claims.sub !== 'string'
    ) {
      throw new UnauthorizedError('TOKEN_INVALID', 'The token is missing required claims');
    }
    if (options.kinds && !options.kinds.includes(claims.knd)) {
      throw new UnauthorizedError(
        'TOKEN_KIND_NOT_ALLOWED',
        `A ${claims.knd} token cannot be used here`,
      );
    }
    return claims;
  }

  jwks(): JSONWebKeySet {
    return this.jwksDocument;
  }
}
