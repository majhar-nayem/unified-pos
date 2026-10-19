import { priceOrder } from '../pricing/price-order.js';
import type { PriceOrderInput } from '../pricing/types.js';

/**
 * Golden-file runner: JSON in → totals out (docs/01-system-architecture.md §7.2,
 * docs/03-implementation-plan.md §9). The runner is pure so the same cases execute under Vitest on
 * the server and inside the POS build; file loading lives with the caller.
 *
 * Golden file shape:
 * {
 *   "name": "...", "description": "...",
 *   "input":    PriceOrderInput with minor amounts as JSON numbers,
 *   "expected": PriceOrderOutput with bigints rendered as JSON numbers
 * }
 */
export interface GoldenCase {
  readonly name: string;
  readonly description?: string;
  readonly input: PriceOrderInput;
  readonly expected: JsonValue;
}

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface GoldenDiff {
  readonly path: string;
  readonly expected: JsonValue | undefined;
  readonly actual: JsonValue | undefined;
}

export interface GoldenResult {
  readonly name: string;
  readonly passed: boolean;
  readonly diffs: readonly GoldenDiff[];
  readonly actual: JsonValue;
}

/** Convert pricing output (with bigints) to plain JSON; bigints become numbers when safe, else strings. */
export function toJsonValue(value: unknown): JsonValue {
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object') {
    const out: { [key: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = toJsonValue(v);
    }
    return out;
  }
  throw new TypeError(`Cannot convert ${typeof value} to JSON`);
}

export function diffJson(
  expected: JsonValue | undefined,
  actual: JsonValue | undefined,
  path = '$',
): GoldenDiff[] {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const diffs: GoldenDiff[] = [];
    const length = Math.max(expected.length, actual.length);
    for (let i = 0; i < length; i++)
      diffs.push(...diffJson(expected[i], actual[i], `${path}[${i}]`));
    return diffs;
  }
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const diffs: GoldenDiff[] = [];
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort())
      diffs.push(...diffJson(expected[key], actual[key], `${path}.${key}`));
    return diffs;
  }
  return expected === actual ? [] : [{ path, expected, actual }];
}

export function runGoldenCase(goldenCase: GoldenCase): GoldenResult {
  const actual = toJsonValue(priceOrder(goldenCase.input));
  const diffs = diffJson(goldenCase.expected, actual);
  return { name: goldenCase.name, passed: diffs.length === 0, diffs, actual };
}

export function runGoldenCases(cases: readonly GoldenCase[]): GoldenResult[] {
  return cases.map(runGoldenCase);
}

export function formatDiffs(result: GoldenResult): string {
  return result.diffs
    .map(
      (d) => `  ${d.path}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`,
    )
    .join('\n');
}

function isPlainObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
