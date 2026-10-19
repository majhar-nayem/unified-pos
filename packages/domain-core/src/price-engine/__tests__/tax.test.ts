import { describe, expect, it } from 'vitest';

import { computeTaxes } from '../tax.js';
import {
  AU_GST_RULE,
  auGstResolver,
  FixedTaxRuleResolver,
  StaticTaxRuleResolver,
  type TaxComponent,
} from '../tax-resolver.js';

const gst: TaxComponent = { ruleId: 'gst', name: 'GST', rate: '0.10' };

describe('computeTaxes', () => {
  it('has no tax without components', () => {
    expect(computeTaxes(1000n, [], true, 'HALF_UP')).toEqual({ taxes: [], taxMinor: 0n });
  });

  it('extracts inclusive tax and adds exclusive tax', () => {
    expect(computeTaxes(1100n, [gst], true, 'HALF_UP').taxMinor).toBe(100n);
    expect(computeTaxes(900n, [gst], true, 'HALF_UP').taxMinor).toBe(82n);
    expect(computeTaxes(1000n, [gst], false, 'HALF_UP').taxMinor).toBe(100n);
    expect(computeTaxes(5997n, [{ ...gst, rate: '0.08875' }], false, 'HALF_UP').taxMinor).toBe(
      532n,
    );
  });

  it('honours the rounding mode', () => {
    expect(computeTaxes(905n, [gst], false, 'DOWN').taxMinor).toBe(90n);
    expect(computeTaxes(905n, [gst], false, 'UP').taxMinor).toBe(91n);
    expect(computeTaxes(905n, [gst], false, 'HALF_UP').taxMinor).toBe(91n);
    expect(computeTaxes(905n, [gst], false, 'HALF_DOWN').taxMinor).toBe(90n);
  });

  it('reports the rule id, name and rate on every component', () => {
    const { taxes } = computeTaxes(1100n, [gst], true, 'HALF_UP');
    expect(taxes).toEqual([{ ruleId: 'gst', name: 'GST', rate: '0.10', amountMinor: 100n }]);
  });

  it('is zero for a zero rate and rejects negative rates', () => {
    expect(computeTaxes(1000n, [{ ...gst, rate: '0' }], true, 'HALF_UP').taxMinor).toBe(0n);
    expect(computeTaxes(1000n, [{ ...gst, rate: '0' }], false, 'HALF_UP').taxMinor).toBe(0n);
    expect(() => computeTaxes(1000n, [{ ...gst, rate: '-0.1' }], true, 'HALF_UP')).toThrow(
      RangeError,
    );
  });

  it('stacks independent components exclusively and splits inclusive tax exactly', () => {
    const state: TaxComponent = { ruleId: 's', name: 'State', rate: '0.06' };
    const city: TaxComponent = { ruleId: 'c', name: 'City', rate: '0.02' };
    expect(
      computeTaxes(10000n, [state, city], false, 'HALF_UP').taxes.map((t) => t.amountMinor),
    ).toEqual([600n, 200n]);
    const inclusive = computeTaxes(10800n, [state, city], true, 'HALF_UP');
    expect(inclusive.taxMinor).toBe(800n);
    expect(inclusive.taxes.map((t) => t.amountMinor)).toEqual([600n, 200n]);
  });

  it('applies compound rates on top of earlier components', () => {
    const excise: TaxComponent = { ruleId: 'e', name: 'Excise', rate: '0.10' };
    const compound: TaxComponent = { ruleId: 'g', name: 'GST', rate: '0.10', compound: true };
    const exclusive = computeTaxes(1000n, [excise, compound], false, 'HALF_UP');
    expect(exclusive.taxes.map((t) => t.amountMinor)).toEqual([100n, 110n]);
    const inclusive = computeTaxes(1210n, [excise, compound], true, 'HALF_UP');
    expect(inclusive.taxes.map((t) => t.amountMinor)).toEqual([100n, 110n]);
    // A non-compound second rate would give 20 % instead of 21 %.
    expect(
      computeTaxes(1000n, [excise, { ...compound, compound: false }], false, 'HALF_UP').taxMinor,
    ).toBe(200n);
  });

  it('inclusive: base plus tax equals the amount for any amount', () => {
    for (let amount = 0n; amount < 400n; amount++) {
      const { taxMinor } = computeTaxes(amount, [gst], true, 'HALF_UP');
      expect(taxMinor >= 0n && taxMinor <= amount).toBe(true);
    }
  });
});

describe('tax resolvers', () => {
  it('auGstResolver: 10 % GST, inclusive, for every class', () => {
    const treatment = auGstResolver.resolve({ taxClassId: null, at: '2026-10-19T00:00:00Z' });
    expect(treatment.inclusiveDefault).toBe(true);
    expect(treatment.components).toEqual([
      { ruleId: 'au-gst', name: 'GST', rate: '0.10', compound: false },
    ]);
    expect(auGstResolver.resolve({ taxClassId: 'anything', at: 'x' }).components).toHaveLength(1);
    expect(AU_GST_RULE.rate).toBe('0.10');
  });

  it('prefers a class-specific rule, then priority, then id', () => {
    const resolver = new StaticTaxRuleResolver([
      { id: 'b-default', taxClassId: null, rate: '0.10' },
      { id: 'free', taxClassId: 'gst-free', rate: '0' },
      { id: 'a-default', taxClassId: null, rate: '0.05', priority: 100 },
      { id: 'high', taxClassId: null, rate: '0.20', priority: 200 },
    ]);
    expect(resolver.resolve({ taxClassId: 'gst-free', at: 'x' }).components[0]!.ruleId).toBe(
      'free',
    );
    expect(resolver.resolve({ taxClassId: null, at: 'x' }).components[0]!.ruleId).toBe('high');
    const tie = new StaticTaxRuleResolver([
      { id: 'b', taxClassId: null, rate: '0.10' },
      { id: 'a', taxClassId: null, rate: '0.05' },
    ]);
    expect(tie.resolve({ taxClassId: null, at: 'x' }).components[0]!.ruleId).toBe('a');
  });

  it('filters by country and region and falls back when nothing matches', () => {
    const resolver = new StaticTaxRuleResolver(
      [
        { id: 'au', taxClassId: null, rate: '0.10', country: 'AU' },
        { id: 'nsw', taxClassId: null, rate: '0.12', country: 'AU', region: 'NSW', priority: 200 },
      ],
      { fallback: { components: [], inclusiveDefault: false } },
    );
    expect(
      resolver.resolve({ taxClassId: null, country: 'AU', region: 'VIC', at: 'x' }).components[0]!
        .ruleId,
    ).toBe('au');
    expect(
      resolver.resolve({ taxClassId: null, country: 'AU', region: 'NSW', at: 'x' }).components[0]!
        .ruleId,
    ).toBe('nsw');
    const none = resolver.resolve({ taxClassId: null, country: 'NZ', at: 'x' });
    expect(none).toEqual({ components: [], inclusiveDefault: false });
    expect(new StaticTaxRuleResolver([]).resolve({ taxClassId: null, at: 'x' })).toEqual({
      components: [],
      inclusiveDefault: true,
    });
  });

  it('stackMatches turns every matching rule into a component', () => {
    const resolver = new StaticTaxRuleResolver(
      [
        { id: 'state', taxClassId: null, rate: '0.06', priority: 2, inclusiveDefault: false },
        { id: 'city', taxClassId: null, rate: '0.02', priority: 1 },
      ],
      { stackMatches: true },
    );
    const t = resolver.resolve({ taxClassId: null, at: 'x' });
    expect(t.components.map((c) => c.ruleId)).toEqual(['state', 'city']);
    expect(t.inclusiveDefault).toBe(false);
  });

  it('FixedTaxRuleResolver returns its treatment', () => {
    const treatment = { components: [gst], inclusiveDefault: false };
    expect(new FixedTaxRuleResolver(treatment).resolve()).toBe(treatment);
  });
});
