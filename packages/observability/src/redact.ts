/**
 * PII and secret redaction applied at the source: log lines, span attributes and log records are scrubbed
 * before they leave the process (docs/01-system-architecture.md §11, §13: "structured JSON, PII-redacted at source").
 * Redaction is by key name (anything that looks like a credential, card or contact detail) and by value pattern
 * (emails, JWTs, bearer and operator tokens, card numbers that pass the Luhn check).
 */

export const REDACTED = '[redacted]';

const SENSITIVE_TOKENS = new Set([
  'password',
  'passwd',
  'pwd',
  'passcode',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apikey',
  'pin',
  'pan',
  'cvv',
  'cvc',
  'cvn',
  'otp',
  'totp',
  'email',
  'phone',
  'mobile',
  'ssn',
  'tfn',
  'dob',
  'birth',
  'birthdate',
  'birthday',
  'bsb',
  'iban',
  'credential',
  'credentials',
]);

const SENSITIVE_PAIRS = new Set([
  'api_key',
  'card_number',
  'credit_card',
  'account_number',
  'private_key',
  'set_cookie',
]);

/** Keys that contain a sensitive word but carry no secret (normalised: snake_case, lower case). */
const DEFAULT_ALLOWED_KEYS = new Set([
  'token_kind',
  'token_type',
  'token_count',
  'token_ttl',
  'pin_attempts',
  'pin_locked',
  'email_verified',
  'phone_verified',
]);

export interface RedactOptions {
  /** Extra keys (any case) never redacted by name. Values are still pattern-scrubbed. */
  readonly allowKeys?: readonly string[];
  readonly maxDepth?: number;
}

function normaliseKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export function isSensitiveKey(
  key: string,
  allowKeys: ReadonlySet<string> = DEFAULT_ALLOWED_KEYS,
): boolean {
  const normalised = normaliseKey(key);
  if (allowKeys.has(normalised)) return false;
  const parts = normalised.split(/[^a-z0-9]+/).filter(Boolean);
  if (parts.some((part) => SENSITIVE_TOKENS.has(part))) return true;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (SENSITIVE_PAIRS.has(`${parts[i]}_${parts[i + 1]}`)) return true;
  }
  return false;
}

const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const PLATFORM_TOKEN = /\bop_[A-Za-z0-9_]{12,}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PAN_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Replace secrets and personal data embedded in free text. */
export function scrubString(value: string): string {
  if (value.length === 0) return value;
  return value
    .replace(JWT, '[jwt]')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(PLATFORM_TOKEN, '[token]')
    .replace(EMAIL, '[email]')
    .replace(PAN_CANDIDATE, (match) => {
      const digits = match.replace(/[ -]/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? '[pan]' : match;
    });
}

/** Deep copy with sensitive keys replaced and strings scrubbed. Errors pass through (the logger's err serializer scrubs them). */
export function redactValue(value: unknown, options: RedactOptions = {}): unknown {
  const allow = options.allowKeys
    ? new Set([...DEFAULT_ALLOWED_KEYS, ...options.allowKeys.map(normaliseKey)])
    : DEFAULT_ALLOWED_KEYS;
  return walk(value, allow, options.maxDepth ?? 8, 0, new WeakSet());
}

function walk(
  value: unknown,
  allow: ReadonlySet<string>,
  maxDepth: number,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date || value instanceof Error) return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[binary]';
  if (seen.has(value)) return '[circular]';
  if (depth >= maxDepth) return '[max-depth]';
  seen.add(value);
  if (Array.isArray(value))
    return value.map((item) => walk(item, allow, maxDepth, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = isSensitiveKey(key, allow)
      ? REDACTED
      : walk(inner, allow, maxDepth, depth + 1, seen);
  }
  return out;
}

/** Convenience for plain objects (log lines). */
export function redactObject<T extends Record<string, unknown>>(
  value: T,
  options?: RedactOptions,
): T {
  return redactValue(value, options) as T;
}

type Attributes = Record<string, unknown>;

/**
 * In-place redaction of flat attribute bags (span attributes, log record attributes, event attributes).
 * Mutates because the SDK hands processors the live object.
 */
export function redactAttributesInPlace(
  attributes: Attributes | undefined,
  options?: RedactOptions,
): void {
  if (!attributes) return;
  const allow = options?.allowKeys
    ? new Set([...DEFAULT_ALLOWED_KEYS, ...options.allowKeys.map(normaliseKey)])
    : DEFAULT_ALLOWED_KEYS;
  for (const key of Object.keys(attributes)) {
    const current = attributes[key];
    if (isSensitiveKey(key, allow)) {
      attributes[key] = REDACTED;
    } else if (typeof current === 'string') {
      attributes[key] = scrubString(current);
    } else if (Array.isArray(current) && current.some((item) => typeof item === 'string')) {
      attributes[key] = current.map((item) =>
        typeof item === 'string' ? scrubString(item) : item,
      );
    }
  }
}
