import { describe, expect, it } from 'vitest';

import { type TaxRuleCandidate, resolveTaxRule, taxRuleApplies } from './tax-rule-resolver.js';

const STANDARD = 'class-standard';
const FREE = 'class-gst-free';

const rule = (id: string, extra: Partial<TaxRuleCandidate>): TaxRuleCandidate => ({
  id,
  jurisdictionCountry: 'AU',
  jurisdictionRegion: null,
  taxClassId: null,
  rate: '0.100000',
  inclusiveDefault: true,
  compound: false,
  priority: 100,
  validFrom: '2000-07-01',
  validTo: null,
  ...extra,
});

/** What provisioning seeds for an AU tenant: one rule per class plus a jurisdiction default. */
const AU: TaxRuleCandidate[] = [
  rule('gst-standard', { taxClassId: STANDARD, rate: '0.100000' }),
  rule('gst-free', { taxClassId: FREE, rate: '0.000000' }),
  rule('gst-default', { rate: '0.100000', priority: 50 }),
];

describe('resolveTaxRule', () => {
  it('picks the class-specific rule for the jurisdiction', () => {
    expect(
      resolveTaxRule(AU, { country: 'AU', taxClassId: STANDARD, on: '2026-10-18' }).rule?.id,
    ).toBe('gst-standard');
    const free = resolveTaxRule(AU, { country: 'AU', taxClassId: FREE, on: '2026-10-18' });
    expect(free.rule?.id).toBe('gst-free');
    expect(free.rate).toBe('0.000000');
    expect(free.inclusive).toBe(true);
  });

  it('falls back to the jurisdiction default for an item without a class or with an unknown class', () => {
    expect(resolveTaxRule(AU, { country: 'AU', on: '2026-10-18' }).rule?.id).toBe('gst-default');
    expect(
      resolveTaxRule(AU, { country: 'AU', taxClassId: 'class-unknown', on: '2026-10-18' }).rule?.id,
    ).toBe('gst-default');
  });

  it('returns no rule, rate 0 and inclusive for an unknown jurisdiction', () => {
    const r = resolveTaxRule(AU, { country: 'NZ', taxClassId: STANDARD, on: '2026-10-18' });
    expect(r).toMatchObject({ rule: null, rate: '0', inclusive: true, ranked: [] });
  });

  it('honours the closed validity range on calendar dates', () => {
    const rules = [
      rule('old', {
        taxClassId: STANDARD,
        rate: '0.100000',
        validFrom: '2000-07-01',
        validTo: '2026-06-30',
      }),
      rule('new', { taxClassId: STANDARD, rate: '0.125000', validFrom: '2026-07-01' }),
    ];
    expect(
      resolveTaxRule(rules, { country: 'AU', taxClassId: STANDARD, on: '2026-06-30' }).rule?.id,
    ).toBe('old');
    expect(
      resolveTaxRule(rules, { country: 'AU', taxClassId: STANDARD, on: '2026-07-01' }).rule?.id,
    ).toBe('new');
    expect(
      resolveTaxRule(rules, { country: 'AU', taxClassId: STANDARD, on: '1999-12-31' }).rule,
    ).toBeNull();
  });

  it('region-specific rules only apply to that region and beat country-wide ones at equal priority', () => {
    const rules = [
      ...AU,
      rule('nsw-levy', { jurisdictionRegion: 'NSW', taxClassId: STANDARD, rate: '0.110000' }),
    ];
    expect(
      resolveTaxRule(rules, {
        country: 'AU',
        region: 'NSW',
        taxClassId: STANDARD,
        on: '2026-10-18',
      }).rule?.id,
    ).toBe('nsw-levy');
    expect(
      resolveTaxRule(rules, {
        country: 'AU',
        region: 'nsw',
        taxClassId: STANDARD,
        on: '2026-10-18',
      }).rule?.id,
    ).toBe('nsw-levy');
    expect(
      resolveTaxRule(rules, {
        country: 'AU',
        region: 'VIC',
        taxClassId: STANDARD,
        on: '2026-10-18',
      }).rule?.id,
    ).toBe('gst-standard');
    expect(
      resolveTaxRule(rules, { country: 'AU', taxClassId: STANDARD, on: '2026-10-18' }).rule?.id,
    ).toBe('gst-standard');
  });

  it('priority overrides specificity', () => {
    const rules = [
      ...AU,
      rule('holiday', {
        rate: '0.000000',
        priority: 1000,
        validFrom: '2026-12-25',
        validTo: '2026-12-25',
      }),
    ];
    expect(
      resolveTaxRule(rules, { country: 'AU', taxClassId: STANDARD, on: '2026-12-25' }).rule?.id,
    ).toBe('holiday');
    expect(
      resolveTaxRule(rules, { country: 'AU', taxClassId: STANDARD, on: '2026-12-26' }).rule?.id,
    ).toBe('gst-standard');
  });

  it('breaks full ties by the latest validFrom, then id, and ranks every candidate', () => {
    const rules = [
      rule('b', { taxClassId: STANDARD, validFrom: '2020-01-01' }),
      rule('a', { taxClassId: STANDARD, validFrom: '2020-01-01' }),
      rule('c', { taxClassId: STANDARD, validFrom: '2024-01-01' }),
      rule('d', { priority: 10 }),
    ];
    const r = resolveTaxRule(rules, { country: 'AU', taxClassId: STANDARD, on: '2026-10-18' });
    expect(r.ranked.map((x) => x.id)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('is case-insensitive on country and region and rejects malformed dates', () => {
    expect(taxRuleApplies(rule('x', {}), { country: 'au', on: '2026-10-18' })).toBe(true);
    expect(() => taxRuleApplies(rule('x', {}), { country: 'AU', on: '18/10/2026' })).toThrow(
      RangeError,
    );
    expect(() =>
      taxRuleApplies(rule('x', { validFrom: '2026-1-1' }), { country: 'AU', on: '2026-10-18' }),
    ).toThrow(RangeError);
  });
});
