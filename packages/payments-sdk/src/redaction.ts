/**
 * Storage redaction for provider requests/responses (payments.payment_attempts.request_redacted /
 * response_redacted) and the PCI name scan (docs/01 §11: no PAN, CVV, track data or expiry in the
 * platform). The field-name patterns are exported so the schema/contract scan test uses the same list.
 */

/** Column / field names that must never exist in payments tables, contracts or adapter types. */
export const FORBIDDEN_FIELD_PATTERNS: readonly RegExp[] = [
  /(^|[^a-z])pan($|[^a-z])/i, // pan, card_pan, panNumber — not "company", "span"
  /card_?(number|num|no)\b/i,
  /primary_?account_?number/i,
  /\bcvv2?\b|\bcvc2?\b|\bcvn\b|\bcid\b|security_?code|card_?verification_?(value|code)/i,
  /track_?(1|2|data)|magstripe|mag_?stripe/i,
  /(^|_)(card_?)?expir(y|ation)(_?(date|month|year))?$/i,
  /\bexp_?(month|year|date|mm|yy)\b/i,
  /\bpin_?block\b|\bicc_?data\b|\bemv_?data\b/i,
];

export function isForbiddenFieldName(name: string): boolean {
  return FORBIDDEN_FIELD_PATTERNS.some((pattern) => pattern.test(name));
}

/** Any 13–19 digit run (with optional spaces/dashes) that passes Luhn: looks like a card number. */
const DIGIT_RUN = /\d(?:[ -]?\d){12,18}/g;

export function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function maskCardLikeNumbers(text: string): string {
  return text.replace(DIGIT_RUN, (match) => {
    const digits = match.replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19 || !passesLuhn(digits)) return match;
    return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
  });
}

export const REDACTED = '[redacted]';

const SECRET_KEYS =
  /^(authorization|api_?key|secret|token|password|client_?secret|signing_?secret)$/i;

/**
 * Deep-copy `value` for storage: forbidden field names and secrets are replaced by `[redacted]`,
 * card-like numbers inside strings are masked to their last four digits, and depth is capped so a
 * hostile payload cannot blow the stack.
 */
export function redactForStorage(value: unknown, depth = 0): unknown {
  if (depth > 32) return REDACTED;
  if (typeof value === 'string') return maskCardLikeNumbers(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactForStorage(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      isForbiddenFieldName(key) || SECRET_KEYS.test(key)
        ? REDACTED
        : redactForStorage(item, depth + 1);
  }
  return out;
}
