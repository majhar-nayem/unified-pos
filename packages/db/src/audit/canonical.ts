/**
 * Canonical JSON for hashing (docs/01-system-architecture.md §11: hash = sha256(prev_hash ‖ canonical(row))).
 *
 * Deterministic across server and devices, and stable through a Postgres jsonb round trip:
 *  - object keys sorted, no whitespace, `undefined` properties dropped
 *  - numbers must be safe integers (money is bigint minor units and travels as strings or
 *    integers; decimals such as rates are strings), so jsonb numeric normalisation cannot
 *    change the value; -0, NaN, Infinity and bigint are rejected
 *  - Dates become ISO-8601 UTC with millisecond precision
 */
export function canonicalJson(value: unknown): string {
  return serialise(value, '$');
}

function serialise(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        throw new TypeError(`canonicalJson: ${path} must be a safe integer, got ${value}`);
      }
      return String(value);
    case 'bigint':
      throw new TypeError(`canonicalJson: ${path} is a bigint; convert it to a string first`);
    case 'undefined':
      throw new TypeError(`canonicalJson: ${path} is undefined`);
    case 'object': {
      if (value instanceof Date) {
        if (Number.isNaN(value.getTime()))
          throw new TypeError(`canonicalJson: ${path} is an invalid Date`);
        return JSON.stringify(value.toISOString());
      }
      if (Array.isArray(value)) {
        return `[${value.map((item, i) => serialise(item === undefined ? null : item, `${path}[${i}]`)).join(',')}]`;
      }
      if (value instanceof Uint8Array) {
        return JSON.stringify(Buffer.from(value).toString('base64'));
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialise(v, `${path}.${k}`)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: ${path} has unsupported type ${typeof value}`);
  }
}
