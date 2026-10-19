import { createHash, randomBytes, randomInt } from 'node:crypto';

const TENANT_BYTES = 16;

/** Opaque refresh token: base64url(tenant id bytes ‖ 32 random bytes), so the server can open the tenant transaction first. */
export function newRefreshToken(tenantId: string): string {
  return Buffer.concat([uuidToBytes(tenantId), randomBytes(32)]).toString('base64url');
}

export function parseRefreshToken(token: string): { tenantId: string; hash: string } | null {
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length !== TENANT_BYTES + 32) return null;
  return { tenantId: bytesToUuid(bytes.subarray(0, TENANT_BYTES)), hash: sha256Hex(token) };
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 12-character Crockford base32 enrollment code (~60 bits), unambiguous when read aloud. */
export function newEnrollmentCode(length = 12): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CROCKFORD[randomInt(CROCKFORD.length)];
  return out;
}

export function newNonce(): string {
  return randomBytes(32).toString('base64');
}

export function newOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function newClientSecret(): string {
  return `sk_${randomBytes(24).toString('base64url')}`;
}

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
