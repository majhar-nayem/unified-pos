#!/usr/bin/env node
/**
 * Seed a local apps/api with everything the POS needs to run end to end, and print how to use it:
 * a tenant, a location, a register, a cashier with a PIN and a one-time enrolment code.
 *
 *   AUTH_OPERATOR_TOKENS="op-1:op_local_operator_token_000000" pnpm --filter @pos/api dev   # in another shell
 *   pnpm --filter @pos/pos seed:dev                      # prints the enrolment code and the cashier id
 *
 * Environment: POS_API_URL (default http://localhost:3000), POS_OPERATOR_TOKEN
 * (default op_local_operator_token_000000), POS_SEED_PIN (default 4821).
 */
import { createHmac, randomUUID } from 'node:crypto';

const base = (process.env.POS_API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const operatorToken = process.env.POS_OPERATOR_TOKEN ?? 'op_local_operator_token_000000';
const pin = process.env.POS_SEED_PIN ?? '4821';
const suffix = Date.now().toString(36);
const slug = `pos-${suffix}`;
const ownerPassword = `Correct-horse-${suffix}-battery`;
const cashierPassword = `Cashier-horse-${suffix}-battery`;

async function call(method, path, { token, body, idempotent } = {}) {
  const response = await fetch(`${base}/v1${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(idempotent ? { 'idempotency-key': randomUUID() } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text}`);
  return json;
}

// RFC 6238 TOTP (SHA-1, 30 s, 6 digits) from an otpauth:// URI.
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of input.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totp(secret, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.error(`Seeding tenant ${slug} on ${base} …`);
const provisioned = await call('POST', '/tenants', {
  token: operatorToken,
  idempotent: true,
  body: {
    slug,
    name: `POS dev ${suffix}`,
    defaultCurrency: 'AUD',
    defaultTimezone: 'Australia/Sydney',
    admin: { email: `owner@${slug}.test`, displayName: 'Dev Owner' },
  },
});
await call('POST', '/users/accept-invite', {
  body: { token: provisioned.admin.inviteToken, password: ownerPassword },
});

// The owner holds admin permissions, so password login asks for a second factor: enrol TOTP.
let login = await call('POST', '/auth/login', {
  body: { tenantSlug: slug, email: `owner@${slug}.test`, password: ownerPassword },
});
if (login.status === 'mfa_enrollment_required') {
  const pre = login.preauthToken;
  const { otpauthUri } = await call('POST', '/users/me/totp/enroll', { token: pre });
  const secret = new URL(otpauthUri).searchParams.get('secret');
  await call('POST', '/users/me/totp/confirm', { token: pre, body: { code: totp(secret) } });
  // A TOTP step cannot be used twice: wait for the next one before the login verification.
  await sleep(30_000 - (Date.now() % 30_000) + 500);
  login = await call('POST', '/auth/mfa/totp', { token: pre, body: { code: totp(secret) } });
}
if (login.status !== 'authenticated') throw new Error(`Unexpected login state ${login.status}`);
const owner = login.tokens.accessToken;

const location = await call('POST', '/locations', {
  token: owner,
  idempotent: true,
  body: {
    orgUnitId: provisioned.rootOrgUnitId,
    code: 'newtown',
    name: 'Newtown',
    kind: 'store',
    timezone: 'Australia/Sydney',
    currency: 'AUD',
  },
});
const register = await call('POST', `/locations/${location.id}/registers`, {
  token: owner,
  idempotent: true,
  body: { code: 'reg-1', name: 'Register 1', kind: 'pos' },
});
const cashier = await call('POST', '/users', {
  token: owner,
  idempotent: true,
  body: { email: `priya@${slug}.test`, displayName: 'Priya Patel', password: cashierPassword },
});
await call('PUT', `/users/${cashier.id}/pin`, {
  token: owner,
  idempotent: true,
  body: { locationId: location.id, pin },
});
const roles = await call('GET', '/roles', { token: owner });
const cashierRole = roles.find((r) => r.key === 'cashier');
await call('POST', '/role-assignments', {
  token: owner,
  idempotent: true,
  body: {
    userId: cashier.id,
    roleId: cashierRole.id,
    scope: { kind: 'location', id: location.id },
    reason: 'POS dev seed',
  },
});
const { code, expiresAt } = await call('POST', '/devices/enrollment-codes', {
  token: owner,
  idempotent: true,
  body: { locationId: location.id, registerId: register.id, kind: 'pos' },
});

console.log(
  JSON.stringify(
    {
      apiUrl: base,
      tenantSlug: slug,
      locationId: location.id,
      registerId: register.id,
      cashierUserId: cashier.id,
      cashierPin: pin,
      enrollmentCode: code,
      enrollmentCodeExpiresAt: expiresAt,
    },
    null,
    2,
  ),
);
