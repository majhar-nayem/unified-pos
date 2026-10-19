import {
  type TaxQuery,
  type TaxResolution,
  type TaxRuleCandidate,
  resolveTaxRule,
} from './tax-rule-resolver.js';

/**
 * Port other streams consume (docs/03 §15.1): the price engine (S-F3) asks for the effective
 * rate and inclusive mode of a line; the API binds it to pricing.tax_rules per tenant, the POS app
 * to its replicated rules. Both call `resolveTaxRule` underneath so results are identical.
 */
export interface TaxRuleResolver {
  resolve(query: TaxQuery): Promise<TaxResolution>;
}

/** In-memory resolver over a fixed rule set (devices, tests, S-F3's stub replacement). */
export class StaticTaxRuleResolver implements TaxRuleResolver {
  constructor(private readonly rules: readonly TaxRuleCandidate[]) {}

  resolve(query: TaxQuery): Promise<TaxResolution> {
    return Promise.resolve(resolveTaxRule(this.rules, query));
  }
}
