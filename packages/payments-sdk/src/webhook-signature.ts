import { createHmac, timingSafeEqual } from 'node:crypto';

import type { InvalidSignature, WebhookHeaders } from './adapter.js';

/**
 * Timestamped HMAC-SHA256 webhook signatures in the `t=<unix>,v1=<hex>` form Stripe uses
 * (`Stripe-Signature`), shared by the mock provider (`X-Mock-Signature`). The signed payload is
 * `${t}.${rawBody}`, so the raw request body must be verified, never a re-serialised object.
 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function signWebhookPayload(
  rawBody: string | Buffer,
  secret: string,
  timestampSeconds: number,
): string {
  const payload = Buffer.concat([
    Buffer.from(`${timestampSeconds}.`),
    typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody,
  ]);
  const v1 = createHmac('sha256', secret).update(payload).digest('hex');
  return `t=${timestampSeconds},v1=${v1}`;
}

export function headerValue(headers: WebhookHeaders, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

export type SignatureVerification =
  | { readonly ok: true; readonly timestampSeconds: number }
  | { readonly ok: false; readonly reason: InvalidSignature['reason'] };

export function verifyWebhookSignature(
  header: string | undefined,
  rawBody: string | Buffer,
  secret: string,
  options: { readonly nowSeconds?: number; readonly toleranceSeconds?: number } = {},
): SignatureVerification {
  if (!header) return { ok: false, reason: 'missing_header' };
  const parts = new Map<string, string[]>();
  for (const segment of header.split(',')) {
    const eq = segment.indexOf('=');
    if (eq <= 0) return { ok: false, reason: 'malformed_header' };
    const key = segment.slice(0, eq).trim();
    const value = segment.slice(eq + 1).trim();
    parts.set(key, [...(parts.get(key) ?? []), value]);
  }
  const t = parts.get('t')?.[0];
  const signatures = parts.get('v1') ?? [];
  if (!t || !/^\d+$/.test(t) || signatures.length === 0)
    return { ok: false, reason: 'malformed_header' };
  const timestampSeconds = Number(t);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - timestampSeconds) > tolerance) return { ok: false, reason: 'stale_timestamp' };

  const expected = signWebhookPayload(rawBody, secret, timestampSeconds).split('v1=')[1]!;
  const expectedBuffer = Buffer.from(expected, 'hex');
  const matched = signatures.some((candidate) => {
    if (!/^[0-9a-f]+$/i.test(candidate)) return false;
    const buffer = Buffer.from(candidate, 'hex');
    return buffer.length === expectedBuffer.length && timingSafeEqual(buffer, expectedBuffer);
  });
  return matched ? { ok: true, timestampSeconds } : { ok: false, reason: 'mismatch' };
}
