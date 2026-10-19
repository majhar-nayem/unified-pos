import crypto from 'k6/crypto';

// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) so setup() can enrol and verify the first admin the way a person would.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32ToBytes(input) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`invalid base32 character "${char}"`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out).buffer;
}

export function totp(secretBase32, offsetSteps = 0, nowMs = Date.now(), digits = 6) {
  const counter = Math.floor(nowMs / 30000) + offsetSteps;
  const message = new ArrayBuffer(8);
  const view = new DataView(message);
  view.setUint32(0, Math.floor(counter / 4294967296));
  view.setUint32(4, counter >>> 0);
  const mac = new Uint8Array(crypto.hmac('sha1', base32ToBytes(secretBase32), message, 'binary'));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(binary % Math.pow(10, digits)).padStart(digits, '0');
}

export function secretFromOtpauthUri(uri) {
  const match = /[?&]secret=([A-Za-z2-7]+)/.exec(uri);
  if (!match) throw new Error('otpauth URI has no secret');
  return match[1];
}
