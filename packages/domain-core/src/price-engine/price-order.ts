import { allocate } from '../money/allocate.js';
import { roundToCashInterval } from '../money/cash-rounding.js';
import { defaultCurrencies, normaliseCode } from '../money/currency.js';
import {
  type Decimal,
  decimalToString,
  divRound,
  mulDecimal,
  parseDecimal,
  pow10,
  type RoundingMode,
} from '../money/decimal.js';
import { toMinor } from '../money/money.js';
import { compareDecimal, nonNegativeMinor, parseQuantity, percentOf, sumBig } from './arith.js';
import { resolveBasePrice } from './price-resolution.js';
import { evaluatePromotions, type WorkingLine } from './promotions.js';
import { localMomentOf, parseInstant } from './schedule.js';
import { computeTaxes } from './tax.js';
import { auGstResolver, type TaxComponent, type TaxRuleResolver } from './tax-resolver.js';
import type {
  AppliedOrderDiscount,
  DraftCharge,
  LineDiscountEntry,
  LineTax,
  ManualDiscount,
  OrderDraft,
  PricedCharge,
  PricedOrder,
  PricedOrderLine,
  PricingContext,
  PricingPort,
  PricingTraceEntry,
  TaxSummaryEntry,
} from './types.js';

/**
 * The pricing pipeline of docs/01-system-architecture.md §7.2, deterministic and pure: the same
 * draft and context produce byte-identical output on the server and on a device.
 *
 *  1 price resolution   override → price lists (assignment priority) → variant default; modifiers
 *  2 manual line discounts, with their authorisation trace
 *  3 promotions         priority order, stack groups, exclusions, one application record per rule
 *  4 order discounts    allocated to lines by largest remainder, so sums match exactly
 *  5 tax per line       through the TaxRuleResolver port; inclusive / exclusive / exempt
 *  6 charges            with their own tax treatment
 *  7 cash rounding      on the cash tender only, recorded as roundingMinor
 *  8 output             totals and the ordered trace
 */
export const priceOrder: PricingPort = (draft, context) => priceOrderImpl(draft, context);

function priceOrderImpl(draft: OrderDraft, context: PricingContext): PricedOrder {
  const currency = normaliseCode(draft.currency);
  defaultCurrencies.get(currency); // throws UnknownCurrencyError early
  const mode: RoundingMode = context.roundingMode ?? 'HALF_UP';
  const at = parseInstant(context.at, 'context.at');
  const moment = localMomentOf(at, context.timezone ?? 'UTC');
  const resolver: TaxRuleResolver = context.taxResolver ?? auGstResolver;
  const taxQuery = (taxClassId: string | null) => ({
    taxClassId,
    country: context.jurisdiction?.country ?? 'AU',
    region: context.jurisdiction?.region ?? null,
    locationId: context.locationId ?? null,
    at: context.at,
  });
  const trace: PricingTraceEntry[] = [];
  const log = (
    step: PricingTraceEntry['step'],
    ref: string,
    amountMinor: bigint,
    detail?: string,
  ) =>
    void trace.push({
      seq: trace.length + 1,
      step,
      ref,
      amountMinor,
      ...(detail ? { detail } : {}),
    });

  const exempt = draft.customer?.taxExempt === true;
  const seenLineIds = new Set<string>();

  // Steps 1–2 ---------------------------------------------------------------------------------
  interface Work extends WorkingLine {
    baseUnitPriceMinor: bigint;
    priceSource: PricedOrderLine['priceSource'];
    modifiersUnitMinor: bigint;
    unitPriceMinor: bigint;
    inclusive: boolean;
    components: readonly TaxComponent[];
    lineDiscountMinor: bigint;
    orderDiscountMinor: bigint;
    discounts: LineDiscountEntry[];
  }
  const working: Work[] = draft.lines.map((line, index) => {
    if (seenLineIds.has(line.id)) throw new RangeError(`Duplicate line id ${line.id}`);
    seenLineIds.add(line.id);
    const quantity = parseQuantity(line.quantity, `Line ${line.id}`);
    const treatment = resolver.resolve(taxQuery(line.taxClassId ?? null));
    const price = resolveBasePrice(line, quantity, currency, context, draft.customer, at);
    const inclusive = price.taxInclusive ?? treatment.inclusiveDefault;
    log('price_resolution', line.id, price.unitPriceMinor, describeSource(price.source));
    let modifiersUnitMinor = 0n;
    for (const modifier of line.modifiers ?? []) {
      const amount = mulDecimal(
        toMinor(modifier.priceMinor),
        parseQuantity(modifier.quantity ?? '1', `Modifier ${modifier.id}`),
        mode,
      );
      modifiersUnitMinor += amount;
      log('modifier', line.id, amount, modifier.id);
    }
    const unitPriceMinor = price.unitPriceMinor + modifiersUnitMinor;
    if (unitPriceMinor < 0n)
      throw new RangeError(`Line ${line.id}: unit price with modifiers is negative`);
    const grossMinor = mulDecimal(unitPriceMinor, quantity, mode);
    const w: Work = {
      index,
      line,
      quantity,
      grossMinor,
      remainingMinor: grossMinor,
      hasManualDiscount: line.manualDiscount !== undefined,
      baseUnitPriceMinor: price.unitPriceMinor,
      priceSource: price.source,
      modifiersUnitMinor,
      unitPriceMinor,
      inclusive,
      components: treatment.components,
      lineDiscountMinor: 0n,
      orderDiscountMinor: 0n,
      discounts: [],
    };
    if (line.manualDiscount) {
      const amount = manualAmount(line.manualDiscount, grossMinor, mode);
      w.lineDiscountMinor = amount;
      w.remainingMinor -= amount;
      w.discounts.push({ kind: 'manual', ref: line.manualDiscount.id, amountMinor: amount });
      log('line_discount', line.id, -amount, describeManual(line.manualDiscount));
    }
    return w;
  });

  // Step 3 ------------------------------------------------------------------------------------
  const promotionOutcome = evaluatePromotions({ lines: working, draft, context, at, moment, mode });
  for (const application of promotionOutcome.applications) {
    log(
      'promotion',
      application.promotionId,
      -application.amountMinor,
      `${application.kind} "${application.name}" ×${application.applications}${application.couponId ? ` coupon ${application.couponId}` : ''}`,
    );
  }
  for (const skip of promotionOutcome.skipped) {
    log(
      'promotion_skipped',
      skip.promotionId,
      0n,
      skip.detail ? `${skip.reason}: ${skip.detail}` : skip.reason,
    );
  }
  const promotionByLine = new Map<number, bigint>();
  for (const [index, entries] of promotionOutcome.perLine) {
    for (const entry of entries) {
      working[index]!.discounts.push({
        kind: 'promotion',
        ref: entry.promotionId,
        amountMinor: entry.amountMinor,
      });
      promotionByLine.set(index, (promotionByLine.get(index) ?? 0n) + entry.amountMinor);
    }
  }

  // Step 4 ------------------------------------------------------------------------------------
  const orderDiscounts: AppliedOrderDiscount[] = [];
  for (const discount of draft.manualDiscounts ?? []) {
    const weights = working.map((w) => (w.remainingMinor < 0n ? 0n : w.remainingMinor));
    const base = sumBig(weights);
    const amount = manualAmount(discount, base, mode);
    log('order_discount', discount.id, -amount, describeManual(discount));
    orderDiscounts.push({
      id: discount.id,
      amountMinor: amount,
      ...(discount.authorization ? { authorization: discount.authorization } : {}),
    });
    if (amount === 0n) continue;
    const shares = allocate(amount, weights);
    shares.forEach((share, i) => {
      const w = working[i]!;
      w.remainingMinor -= share;
      w.orderDiscountMinor += share;
      if (share > 0n) {
        w.discounts.push({ kind: 'order', ref: discount.id, amountMinor: share });
        log('allocation', w.line.id, -share, discount.id);
      }
    });
  }

  // Step 5 ------------------------------------------------------------------------------------
  const summary = new Map<string, TaxSummaryEntry>();
  const addSummary = (taxes: readonly LineTax[], taxableMinor: bigint) => {
    for (const t of taxes) {
      const key = `${t.ruleId ?? ''}|${t.name}|${t.rate}`;
      const existing = summary.get(key);
      summary.set(key, {
        ruleId: t.ruleId,
        name: t.name,
        rate: t.rate,
        taxableMinor: (existing?.taxableMinor ?? 0n) + taxableMinor,
        taxMinor: (existing?.taxMinor ?? 0n) + t.amountMinor,
      });
    }
  };
  const lines: PricedOrderLine[] = working.map((w) => {
    const netMinor = w.remainingMinor;
    const computed = computeTaxes(netMinor, w.components, w.inclusive, mode);
    let taxes: LineTax[] = computed.taxes;
    let taxMinor = computed.taxMinor;
    let taxExemptMinor = 0n;
    if (exempt && taxMinor > 0n) {
      taxExemptMinor = taxMinor;
      log(
        'tax_exemption',
        w.line.id,
        -taxMinor,
        draft.customer?.taxExemptionReason ?? 'customer exempt',
      );
      taxes = [];
      taxMinor = 0n;
    } else {
      addSummary(taxes, w.inclusive ? netMinor - taxMinor : netMinor);
    }
    log(
      'tax',
      w.line.id,
      taxMinor,
      taxes.map((t) => `${t.name} ${t.rate}`).join(', ') || undefined,
    );
    const totalMinor = w.inclusive ? netMinor - taxExemptMinor : netMinor + taxMinor;
    return {
      id: w.line.id,
      variantId: w.line.variantId,
      quantity: decimalToString(w.quantity),
      baseUnitPriceMinor: w.baseUnitPriceMinor,
      priceSource: w.priceSource,
      modifiersUnitMinor: w.modifiersUnitMinor,
      unitPriceMinor: w.unitPriceMinor,
      grossMinor: w.grossMinor,
      lineDiscountMinor: w.lineDiscountMinor,
      promotionDiscountMinor: promotionByLine.get(w.index) ?? 0n,
      orderDiscountMinor: w.orderDiscountMinor,
      discounts: w.discounts,
      netMinor,
      taxInclusive: w.inclusive,
      taxClassId: w.line.taxClassId ?? null,
      taxes,
      taxMinor,
      taxExemptMinor,
      totalMinor,
    };
  });

  const subtotalMinor = sumBig(lines.map((l) => l.grossMinor));
  const lineDiscountMinor = sumBig(lines.map((l) => l.lineDiscountMinor));
  const promotionDiscountMinor = sumBig(lines.map((l) => l.promotionDiscountMinor));
  const orderDiscountMinor = sumBig(lines.map((l) => l.orderDiscountMinor));
  const netMinor = sumBig(lines.map((l) => l.netMinor));

  // Step 6 ------------------------------------------------------------------------------------
  const charges: PricedCharge[] = (draft.charges ?? []).map((charge) => {
    const amountMinor = chargeAmount(charge, netMinor, mode);
    log('charge', charge.id, amountMinor, charge.kind);
    let components: readonly TaxComponent[];
    let inclusive: boolean;
    if (charge.taxRate !== undefined) {
      components = [{ ruleId: null, name: 'Tax', rate: String(charge.taxRate) }];
      inclusive = charge.taxInclusive ?? true;
    } else {
      const treatment = resolver.resolve(taxQuery(charge.taxClassId ?? null));
      components = treatment.components;
      inclusive = charge.taxInclusive ?? treatment.inclusiveDefault;
    }
    const computed = computeTaxes(amountMinor, components, inclusive, mode);
    let taxes: LineTax[] = computed.taxes;
    let taxMinor = computed.taxMinor;
    let exemptMinor = 0n;
    if (exempt && taxMinor > 0n) {
      exemptMinor = taxMinor;
      log(
        'tax_exemption',
        charge.id,
        -taxMinor,
        draft.customer?.taxExemptionReason ?? 'customer exempt',
      );
      taxes = [];
      taxMinor = 0n;
    } else {
      addSummary(taxes, inclusive ? amountMinor - taxMinor : amountMinor);
    }
    log('tax', charge.id, taxMinor);
    return {
      id: charge.id,
      kind: charge.kind,
      ...(charge.name ? { name: charge.name } : {}),
      amountMinor,
      taxInclusive: inclusive,
      taxes,
      taxMinor,
      taxExemptMinor: exemptMinor,
      totalMinor: inclusive ? amountMinor - exemptMinor : amountMinor + taxMinor,
    };
  });

  const taxExemptMinor = sumBig(lines.map((l) => l.taxExemptMinor));
  const chargesMinor = sumBig(charges.map((c) => c.totalMinor));
  const totalMinor = sumBig(lines.map((l) => l.totalMinor)) + chargesMinor;

  // Step 7 ------------------------------------------------------------------------------------
  const roundingMinor = cashRounding(draft, context, currency, totalMinor, log);

  return {
    currency,
    at: context.at,
    lines,
    charges,
    promotions: promotionOutcome.applications,
    skippedPromotions: promotionOutcome.skipped,
    orderDiscounts,
    subtotalMinor,
    lineDiscountMinor,
    promotionDiscountMinor,
    orderDiscountMinor,
    discountMinor: lineDiscountMinor + promotionDiscountMinor + orderDiscountMinor,
    netMinor,
    taxMinor: sumBig(lines.map((l) => l.taxMinor)) + sumBig(charges.map((c) => c.taxMinor)),
    taxExemptMinor: taxExemptMinor + sumBig(charges.map((c) => c.taxExemptMinor)),
    taxSummary: [...summary.values()].sort(
      (a, b) =>
        compareDecimal(parseDecimal(a.rate), parseDecimal(b.rate)) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
        (a.ruleId ?? '').localeCompare(b.ruleId ?? ''),
    ),
    chargesMinor,
    totalMinor,
    roundingMinor,
    amountDueMinor: totalMinor + roundingMinor,
    trace,
  };
}

function cashRounding(
  draft: OrderDraft,
  context: PricingContext,
  currency: string,
  totalMinor: bigint,
  log: (step: PricingTraceEntry['step'], ref: string, amount: bigint, detail?: string) => void,
): bigint {
  const tenders = draft.tenders ?? [];
  if (!tenders.some((t) => t.method === 'cash')) return 0n;
  const nonCash = sumBig(
    tenders
      .filter((t) => t.method !== 'cash')
      .map((t) => nonNegativeMinor(t.amountMinor ?? 0, 'tender')),
  );
  if (nonCash > totalMinor) throw new RangeError('Non-cash tenders exceed the order total');
  const explicitCash = tenders
    .filter((t) => t.method === 'cash' && t.amountMinor !== undefined)
    .map((t) => nonNegativeMinor(t.amountMinor!, 'tender'));
  const cashPortion = explicitCash.length > 0 ? sumBig(explicitCash) : totalMinor - nonCash;
  if (cashPortion <= 0n) return 0n;
  const rule =
    context.cashRounding === null
      ? undefined
      : (context.cashRounding ?? defaultCurrencies.get(currency).cashRounding);
  if (!rule) return 0n;
  const { roundingMinor } = roundToCashInterval(cashPortion, rule);
  log(
    'cash_rounding',
    'tender',
    roundingMinor,
    `cash ${cashPortion} → ${cashPortion + roundingMinor}`,
  );
  return roundingMinor;
}

function manualAmount(discount: ManualDiscount, base: bigint, mode: RoundingMode): bigint {
  let amount: bigint;
  if (discount.kind === 'percent') {
    amount = percentOf(base < 0n ? 0n : base, discount.value, mode, `Discount ${discount.id}`);
  } else {
    amount = nonNegativeMinor(toMinorValue(discount.value), `Discount ${discount.id}`);
  }
  if (base <= 0n) return 0n;
  return amount > base ? base : amount;
}

function toMinorValue(value: string | number): bigint {
  return toMinor(value);
}

function chargeAmount(charge: DraftCharge, linesNetMinor: bigint, mode: RoundingMode): bigint {
  if (charge.amountMinor !== undefined && charge.percent !== undefined) {
    throw new RangeError(`Charge ${charge.id}: specify either amountMinor or percent, not both`);
  }
  if (charge.amountMinor !== undefined)
    return nonNegativeMinor(charge.amountMinor, `Charge ${charge.id}`);
  if (charge.percent !== undefined) {
    const percent: Decimal = parseDecimal(charge.percent);
    if (percent.unscaled < 0n)
      throw new RangeError(`Charge ${charge.id}: percent must not be negative`);
    return divRound(linesNetMinor * percent.unscaled, 100n * pow10(percent.scale), mode);
  }
  throw new RangeError(`Charge ${charge.id}: amountMinor or percent is required`);
}

function describeManual(discount: ManualDiscount): string {
  const base = discount.kind === 'percent' ? `${discount.value}%` : `${discount.value} minor`;
  const auth = discount.authorization;
  const parts = [base];
  if (discount.reason) parts.push(`reason: ${discount.reason}`);
  if (auth) {
    parts.push(`authorized by ${auth.authorizedBy}`);
    if (auth.method) parts.push(`via ${auth.method}`);
    if (auth.approvalId) parts.push(`approval ${auth.approvalId}`);
  }
  return parts.join(' ');
}

function describeSource(source: PricedOrderLine['priceSource']): string {
  switch (source.kind) {
    case 'override':
      return source.authorizedBy ? `override authorized by ${source.authorizedBy}` : 'override';
    case 'price_list':
      return `price list ${source.priceListId} entry ${source.entryId}`;
    default:
      return 'variant default';
  }
}
