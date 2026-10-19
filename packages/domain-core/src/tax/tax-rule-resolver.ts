/**
 * Tax rule resolution (docs/02-database-design.md §2.2, pricing.tax_rules). Rates are tenant
 * data: this resolver only picks the applicable row for (jurisdiction, tax class, date). The same
 * code runs on the server and on devices against the replicated rules, so pricing is identical
 * offline (docs/01 §7.2 step 5 consumes the resolved rate and inclusive flag).
 *
 * Matching: country equal; a rule without a region covers the whole country, one with a region
 * only that region; a rule without a tax class is the jurisdiction default and matches any class
 * (or no class); a rule with a class only that class. Validity is a closed calendar-date range
 * [validFrom, validTo] (validTo null = open-ended). Ranking: priority (higher wins), then
 * specificity (class match, then region match), then the latest validFrom, then id.
 */

export interface TaxRuleCandidate {
  readonly id: string;
  readonly jurisdictionCountry: string;
  readonly jurisdictionRegion: string | null;
  readonly taxClassId: string | null;
  /** Decimal fraction string, e.g. "0.100000". */
  readonly rate: string;
  readonly inclusiveDefault: boolean;
  readonly compound: boolean;
  readonly priority: number;
  /** YYYY-MM-DD */
  readonly validFrom: string;
  /** YYYY-MM-DD, inclusive; null = open-ended. */
  readonly validTo: string | null;
}

export interface TaxQuery {
  readonly country: string;
  readonly region?: string | null;
  readonly taxClassId?: string | null;
  /** YYYY-MM-DD in the location's time zone. */
  readonly on: string;
}

export interface TaxResolution<T extends TaxRuleCandidate = TaxRuleCandidate> {
  readonly rule: T | null;
  /** Every applicable rule, best first. */
  readonly ranked: readonly T[];
  /** Effective rate for the pricing pipeline: "0" when no rule applies. */
  readonly rate: string;
  /** Effective inclusive flag: true (price includes tax) when no rule applies, so totals never grow unexpectedly. */
  readonly inclusive: boolean;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string, label: string): void {
  if (!DATE.test(value)) throw new RangeError(`${label} must be YYYY-MM-DD, got "${value}"`);
}

function norm(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.toUpperCase();
}

export function taxRuleApplies(rule: TaxRuleCandidate, query: TaxQuery): boolean {
  assertDate(query.on, 'query.on');
  assertDate(rule.validFrom, 'rule.validFrom');
  if (rule.validTo !== null) assertDate(rule.validTo, 'rule.validTo');
  if (norm(rule.jurisdictionCountry) !== norm(query.country)) return false;
  const ruleRegion = norm(rule.jurisdictionRegion);
  if (ruleRegion !== null && ruleRegion !== norm(query.region)) return false;
  const queryClass = query.taxClassId ?? null;
  if (rule.taxClassId !== null && rule.taxClassId !== queryClass) return false;
  if (query.on < rule.validFrom) return false;
  if (rule.validTo !== null && query.on > rule.validTo) return false;
  return true;
}

/** 2 for a class-specific rule, +1 for a region-specific rule. */
export function taxRuleSpecificity(rule: TaxRuleCandidate): number {
  return (rule.taxClassId !== null ? 2 : 0) + (norm(rule.jurisdictionRegion) !== null ? 1 : 0);
}

export function resolveTaxRule<T extends TaxRuleCandidate>(
  rules: readonly T[],
  query: TaxQuery,
): TaxResolution<T> {
  const ranked = rules
    .filter((rule) => taxRuleApplies(rule, query))
    .sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      const sa = taxRuleSpecificity(a);
      const sb = taxRuleSpecificity(b);
      if (sa !== sb) return sb - sa;
      if (a.validFrom !== b.validFrom) return a.validFrom < b.validFrom ? 1 : -1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  const rule = ranked[0] ?? null;
  return {
    rule,
    ranked,
    rate: rule ? rule.rate : '0',
    inclusive: rule ? rule.inclusiveDefault : true,
  };
}
