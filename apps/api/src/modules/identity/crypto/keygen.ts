#!/usr/bin/env node
/** `pnpm --filter @pos/api auth:keygen` — print an EdDSA signing key pair and a secrets key for .env. */
import { randomBytes, randomUUID } from 'node:crypto';

import { exportJWK, exportPKCS8, generateKeyPair } from 'jose';

const pair = await generateKeyPair('EdDSA', { extractable: true });
const kid = `k-${randomUUID().slice(0, 8)}`;
const pem = await exportPKCS8(pair.privateKey);
const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: 'EdDSA', use: 'sig' };
console.log(`AUTH_JWT_KID=${kid}`);
console.log(`AUTH_JWT_PRIVATE_KEY=${Buffer.from(pem).toString('base64')}`);
console.log(`AUTH_JWT_PUBLIC_JWKS=${JSON.stringify({ keys: [jwk] })}`);
console.log(`AUTH_SECRETS_KEY=${randomBytes(32).toString('base64')}`);
