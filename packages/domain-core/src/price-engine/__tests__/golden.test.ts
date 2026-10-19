import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { toJsonValue } from '../../golden/runner.js';
import { priceOrder } from '../price-order.js';
import {
  contextOf,
  deepFreeze,
  type Mismatch,
  type PriceGoldenCase,
  repricingDraft,
  runPriceGolden,
} from './golden-runner.js';

const goldenDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../golden/price-engine');
const files = readdirSync(goldenDir)
  .filter((f) => /^\d{3}-.*\.json$/.test(f))
  .sort();
const cases = files.map((file) => ({
  file,
  golden: JSON.parse(readFileSync(join(goldenDir, file), 'utf8')) as PriceGoldenCase,
}));

const format = (mismatches: readonly Mismatch[]) =>
  mismatches
    .slice(0, 8)
    .map(
      (m) => `  ${m.path}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.actual)}`,
    )
    .join('\n');

describe('price engine golden files (F3)', () => {
  it('has at least 150 cases covering the required families', () => {
    expect(cases.length).toBeGreaterThanOrEqual(150);
    const tags = new Set(cases.flatMap((c) => c.golden.tags ?? []));
    for (const required of [
      'brief',
      'bundle',
      'mixed-rates',
      'parity',
      'allocation',
      'repricing',
    ]) {
      expect(tags.has(required), `tag ${required}`).toBe(true);
    }
    expect(new Set(cases.map((c) => c.golden.name)).size).toBe(cases.length);
  });

  for (const { file, golden } of cases) {
    it(`${file}: ${golden.name}`, () => {
      const { mismatches } = runPriceGolden(golden);
      expect(mismatches, `golden mismatch in ${file}\n${format(mismatches)}`).toEqual([]);
    });
  }

  describe('idempotent re-pricing', () => {
    it('pricing twice gives identical output and never mutates the frozen input', () => {
      for (const { golden } of cases) {
        if (golden.expectError !== undefined) continue;
        const draft = deepFreeze(structuredClone(golden.input.draft));
        const context = deepFreeze(contextOf(golden));
        expect(priceOrder(draft, context)).toEqual(priceOrder(draft, context));
      }
    });

    it('re-pricing the resolved unit prices as overrides reproduces totals, tax and rounding', () => {
      const repricing = cases.filter((c) => c.golden.tags?.includes('repricing'));
      expect(repricing.length).toBeGreaterThanOrEqual(3);
      for (const { file, golden } of repricing) {
        const context = contextOf(golden);
        const first = priceOrder(golden.input.draft, context);
        const second = priceOrder(repricingDraft(golden.input.draft, first), context);
        const pick = (p: typeof first) =>
          toJsonValue({
            subtotalMinor: p.subtotalMinor,
            discountMinor: p.discountMinor,
            netMinor: p.netMinor,
            taxMinor: p.taxMinor,
            chargesMinor: p.chargesMinor,
            totalMinor: p.totalMinor,
            roundingMinor: p.roundingMinor,
            amountDueMinor: p.amountDueMinor,
            lines: p.lines.map((l) => [l.grossMinor, l.netMinor, l.taxMinor, l.totalMinor]),
          });
        expect(pick(second), file).toEqual(pick(first));
      }
    });
  });
});
