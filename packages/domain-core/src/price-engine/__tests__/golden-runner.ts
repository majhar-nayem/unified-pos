import { toJsonValue, type JsonValue } from '../../golden/runner.js';
import { priceOrder } from '../price-order.js';
import { StaticTaxRuleResolver, type StaticTaxRule } from '../tax-resolver.js';
import type { OrderDraft, PricedOrder, PricingContext } from '../types.js';

/** Golden file for the F3 engine. `expected` is a partial match; `expectError` a message regex. */
export interface PriceGoldenCase {
  readonly name: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly input: {
    readonly draft: OrderDraft;
    readonly context: PricingContext;
    readonly taxRules?: readonly StaticTaxRule[];
    /** Every matching rule stacks as a component (state + city, excise + GST). */
    readonly stackTaxRules?: boolean;
  };
  readonly expected?: { readonly [key: string]: JsonValue };
  readonly expectError?: string;
}

export interface Mismatch {
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export function contextOf(c: PriceGoldenCase): PricingContext {
  const { taxRules } = c.input;
  return taxRules
    ? {
        ...c.input.context,
        taxResolver: new StaticTaxRuleResolver(taxRules, {
          stackMatches: c.input.stackTaxRules === true,
        }),
      }
    : c.input.context;
}

/** Every key of `expected` must be present and equal; arrays must have the same length. */
export function subsetMismatches(expected: unknown, actual: unknown, path = '$'): Mismatch[] {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [{ path, expected, actual }];
    if (expected.length !== actual.length) {
      return [{ path: `${path}.length`, expected: expected.length, actual: actual.length }];
    }
    return expected.flatMap((e, i) => subsetMismatches(e, actual[i], `${path}[${i}]`));
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return [{ path, expected, actual }];
    return Object.entries(expected as Record<string, unknown>).flatMap(([key, value]) => {
      if (key.startsWith('$')) return [];
      return subsetMismatches(value, (actual as Record<string, unknown>)[key], `${path}.${key}`);
    });
  }
  return expected === actual ? [] : [{ path, expected, actual }];
}

export function specialMismatches(
  expected: Record<string, unknown>,
  priced: PricedOrder,
): Mismatch[] {
  const out: Mismatch[] = [];
  const trace = toJsonValue(priced.trace) as Array<Record<string, JsonValue>>;
  const includes = expected['$traceIncludes'] as Array<Record<string, JsonValue>> | undefined;
  for (const want of includes ?? []) {
    if (!trace.some((t) => subsetMismatches(want, t).length === 0)) {
      out.push({ path: '$traceIncludes', expected: want, actual: trace });
    }
  }
  const order = expected['$stepOrder'] as string[] | undefined;
  if (order) {
    const steps = priced.trace.map((t) => t.step).filter((s) => order.includes(s));
    const collapsed = steps.filter((s, i) => i === 0 || s !== steps[i - 1]);
    // Steps must appear in this order (consecutive duplicates collapsed per line/charge).
    let cursor = 0;
    for (const s of collapsed) {
      const at = order.indexOf(s, cursor);
      if (at < 0) {
        out.push({ path: '$stepOrder', expected: order, actual: collapsed });
        break;
      }
      cursor = at;
    }
    for (const s of order) {
      if (!collapsed.includes(s as never))
        out.push({ path: '$stepOrder', expected: s, actual: collapsed });
    }
  }
  return out;
}

export function runPriceGolden(c: PriceGoldenCase): {
  priced?: PricedOrder;
  mismatches: Mismatch[];
} {
  const draft = deepFreeze(structuredClone(c.input.draft));
  const context = deepFreeze(contextOf(c));
  if (c.expectError !== undefined) {
    try {
      priceOrder(draft, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new RegExp(c.expectError).test(message)
        ? { mismatches: [] }
        : { mismatches: [{ path: 'error', expected: c.expectError, actual: message }] };
    }
    return { mismatches: [{ path: 'error', expected: c.expectError, actual: 'no error' }] };
  }
  const priced = priceOrder(draft, context);
  const json = toJsonValue(priced);
  const expected = c.expected ?? {};
  return {
    priced,
    mismatches: [...subsetMismatches(expected, json), ...specialMismatches(expected, priced)],
  };
}

/**
 * Draft that re-prices a priced order: resolved unit prices (modifiers included) become
 * authorised overrides in the same tax mode; manual discounts, charges and tenders carry over;
 * price lists and promotions are dropped. Valid only for cases without promotions.
 */
export function repricingDraft(original: OrderDraft, priced: PricedOrder): OrderDraft {
  return {
    ...original,
    lines: original.lines.map((line, i) => {
      const p = priced.lines[i]!;
      const { modifiers: _m, defaultUnitPriceMinor: _d, ...rest } = line;
      return {
        ...rest,
        priceOverride: { unitPriceMinor: p.unitPriceMinor, taxInclusive: p.taxInclusive },
      };
    }),
  };
}
