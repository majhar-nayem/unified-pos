/**
 * Tax resolution port of the price engine (docs/01-system-architecture.md §7.2 step 5).
 *
 * Stream S-F3 consumes tax rules only through this interface (docs/03-implementation-plan.md
 * §15.1); the real resolver over pricing.tax_rules belongs to S-F2 and is wired in the Wave 2
 * integration slice. Until then `auGstResolver` (10 % GST, prices tax-inclusive, the rate is
 * data in this file and not in the engine) and `StaticTaxRuleResolver` (a table the golden files
 * and the API build from data) stand in.
 */

export interface TaxComponent {
  readonly ruleId: string | null;
  readonly name: string;
  /** Decimal fraction string, e.g. "0.10". */
  readonly rate: string;
  /** Applied on top of the base plus every previous component (excise, levies). */
  readonly compound?: boolean;
}

export interface TaxTreatment {
  /** Zero or more rates; empty = no tax. */
  readonly components: readonly TaxComponent[];
  /** Whether prices for this class are tax-inclusive by default. */
  readonly inclusiveDefault: boolean;
}

export interface TaxTreatmentQuery {
  readonly taxClassId: string | null;
  readonly country?: string | null;
  readonly region?: string | null;
  readonly locationId?: string | null;
  /** ISO instant of the sale. */
  readonly at: string;
}

export interface TaxRuleResolver {
  resolve(query: TaxTreatmentQuery): TaxTreatment;
}

export interface StaticTaxRule {
  readonly id: string;
  readonly name?: string;
  /** null matches any class (jurisdiction default); a class id matches only that class. */
  readonly taxClassId: string | null;
  readonly rate: string;
  readonly inclusiveDefault?: boolean;
  readonly compound?: boolean;
  /** Higher wins. Default 100. */
  readonly priority?: number;
  readonly country?: string | null;
  readonly region?: string | null;
}

export interface StaticTaxRuleResolverOptions {
  /** Treatment when no rule matches. Default: no components, inclusive. */
  readonly fallback?: TaxTreatment;
  /** true: every matching non-compound rule of the best priority stacks as components (multiple rates). */
  readonly stackMatches?: boolean;
}

/**
 * Table-driven resolver. Picks the class-specific rule over the jurisdiction default, higher
 * priority first; with `stackMatches` every rule of the winning specificity becomes a component
 * (e.g. state + city sales tax).
 */
export class StaticTaxRuleResolver implements TaxRuleResolver {
  constructor(
    private readonly rules: readonly StaticTaxRule[],
    private readonly options: StaticTaxRuleResolverOptions = {},
  ) {}

  resolve(query: TaxTreatmentQuery): TaxTreatment {
    const classId = query.taxClassId ?? null;
    const matching = this.rules.filter((rule) => {
      if (rule.country && query.country && rule.country !== query.country) return false;
      if (rule.region && rule.region !== (query.region ?? null)) return false;
      return rule.taxClassId === null || rule.taxClassId === classId;
    });
    if (matching.length === 0) {
      return this.options.fallback ?? { components: [], inclusiveDefault: true };
    }
    const specific = matching.filter((r) => r.taxClassId !== null);
    const pool = specific.length > 0 ? specific : matching;
    const sorted = [...pool].sort((a, b) => {
      const pa = a.priority ?? 100;
      const pb = b.priority ?? 100;
      if (pa !== pb) return pb - pa;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const chosen = this.options.stackMatches ? sorted : [sorted[0]!];
    return {
      components: chosen.map((r) => ({
        ruleId: r.id,
        name: r.name ?? r.id,
        rate: r.rate,
        compound: r.compound ?? false,
      })),
      inclusiveDefault: sorted[0]!.inclusiveDefault ?? true,
    };
  }
}

/** Fixed treatment for every query (tests, the API preview when nothing else is wired). */
export class FixedTaxRuleResolver implements TaxRuleResolver {
  constructor(private readonly treatment: TaxTreatment) {}

  resolve(): TaxTreatment {
    return this.treatment;
  }
}

/** Default stub: Australian GST, 10 %, prices inclusive. Replaced by S-F2's resolver in Wave 2. */
export const AU_GST_RULE: StaticTaxRule = {
  id: 'au-gst',
  name: 'GST',
  taxClassId: null,
  rate: '0.10',
  inclusiveDefault: true,
  country: 'AU',
};

export const auGstResolver: TaxRuleResolver = new StaticTaxRuleResolver([AU_GST_RULE]);
