import { allocate } from '../money/allocate.js';
import { type RoundingMode, divRound, mulDecimal, parseDecimal, pow10 } from '../money/decimal.js';
import type {
  CatalogLookupContext,
  CatalogPort,
  PricedCharge,
  PricedDiscount,
  PricedLine,
  PricedOrder,
  PricingPort,
  PricingRequest,
  SubmittedLine,
  VariantSnapshot,
} from './ports.js';
import { parseQuantity } from './quantity.js';
import { type LineTax, ruleInvalid } from './types.js';

/** Tax class code the stub treats as GST-free. Everything else is taxed at GST 10 %. */
export const STUB_GST_FREE_CLASS = 'gst_free';
export const STUB_GST_RATE = '0.100000';

/**
 * STUB (until the integration slice wires S-F3's price engine): list price from the submitted
 * line, no promotions or price lists, GST 10 % on everything except class `gst_free`, inclusive or
 * exclusive according to the order's pricing mode. Manual and externally supplied discounts are
 * applied as given: line discounts first (sequentially), then order discounts allocated to lines
 * by the largest-remainder method.
 */
export class StubPricingPort implements PricingPort {
  constructor(private readonly mode: RoundingMode = 'HALF_UP') {}

  priceOrder(request: PricingRequest): PricedOrder {
    const trace: PricedOrder['trace'][number][] = [];
    const inclusive = request.pricingMode === 'tax_inclusive';

    const work = request.lines.map((line) => {
      const gross =
        line.grossOverrideMinor ??
        mulDecimal(line.unitPriceMinor, quantityDecimal(line.quantity), this.mode);
      trace.push({ step: 'base_price', ref: line.id, amountMinor: gross });
      return { line, gross, lineDiscount: 0n, orderDiscount: 0n };
    });
    const byId = new Map(work.map((w) => [w.line.id, w]));
    const resolved = new Map<string, bigint>();

    // Line-level discounts, in the order given, each on what is left.
    for (const d of request.discounts) {
      if (d.lineId === null) continue;
      const w = byId.get(d.lineId);
      if (!w)
        throw ruleInvalid('DISCOUNT_LINE_UNKNOWN', `Discount ${d.id} targets an unknown line`);
      const remaining = w.gross - w.lineDiscount;
      const amount = this.discountAmount(d.percent, d.amountMinor, remaining);
      w.lineDiscount += amount;
      resolved.set(d.id, amount);
      trace.push({ step: 'line_discount', ref: d.lineId, amountMinor: -amount, detail: d.id });
    }

    // Order-level discounts, sequential on the remaining positive base, allocated by weight.
    const positive = (w: (typeof work)[number]) => {
      const left = w.gross - w.lineDiscount - w.orderDiscount;
      return left > 0n ? left : 0n;
    };
    for (const d of request.discounts) {
      if (d.lineId !== null) continue;
      const base = work.reduce((acc, w) => acc + positive(w), 0n);
      const amount = this.discountAmount(d.percent, d.amountMinor, base);
      resolved.set(d.id, amount);
      trace.push({ step: 'order_discount', ref: d.id, amountMinor: -amount });
      if (amount === 0n) continue;
      const shares = allocate(amount, work.map(positive));
      shares.forEach((share, i) => {
        const w = work[i]!;
        w.orderDiscount += share;
        if (share !== 0n)
          trace.push({ step: 'allocation', ref: w.line.id, amountMinor: -share, detail: d.id });
      });
    }

    const lines: PricedLine[] = work.map((w) => {
      const discount = w.lineDiscount + w.orderDiscount;
      const net = w.gross - discount;
      const rate = w.line.taxClassCode === STUB_GST_FREE_CLASS ? '0' : STUB_GST_RATE;
      const taxes = [this.taxRow(net, rate, inclusive)];
      const taxMinor = taxes.reduce((a, t) => a + t.taxMinor, 0n);
      trace.push({ step: 'tax', ref: w.line.id, amountMinor: taxMinor });
      return {
        id: w.line.id,
        grossMinor: w.gross,
        discountMinor: discount,
        netMinor: net,
        taxMinor,
        totalMinor: inclusive ? net : net + taxMinor,
        taxes,
      };
    });

    const netById = new Map(lines.map((l) => [l.id, l.netMinor]));
    const charges: PricedCharge[] = request.charges.map((c) => {
      const base = c.appliesToLineIds.reduce((a, id) => a + (netById.get(id) ?? 0n), 0n);
      const amount =
        c.percent !== null ? this.percentOf(base > 0n ? base : 0n, c.percent) : c.amountMinor;
      const rate = c.taxable ? STUB_GST_RATE : '0';
      const taxMinor = this.taxRow(amount, rate, inclusive).taxMinor;
      trace.push({ step: 'charge', ref: c.id, amountMinor: amount, detail: c.kind });
      return { id: c.id, amountMinor: amount, taxMinor };
    });

    const discounts: PricedDiscount[] = request.discounts.map((d) => ({
      id: d.id,
      amountMinor: resolved.get(d.id) ?? 0n,
    }));
    return { lines, discounts, charges, trace };
  }

  private percentOf(base: bigint, percent: string): bigint {
    const p = parseDecimal(percent);
    if (p.unscaled < 0n) throw ruleInvalid('PERCENT_NEGATIVE', 'Percent must not be negative');
    return divRound(base * p.unscaled, 100n * pow10(p.scale), this.mode);
  }

  private discountAmount(percent: string | null, fixed: bigint, base: bigint): bigint {
    if (base <= 0n) return 0n;
    const amount = percent !== null ? this.percentOf(base, percent) : fixed;
    if (amount < 0n) throw ruleInvalid('DISCOUNT_NEGATIVE', 'Discount must not be negative');
    return amount > base ? base : amount;
  }

  private taxRow(net: bigint, rate: string, inclusive: boolean): LineTax {
    const r = parseDecimal(rate);
    let tax = 0n;
    if (r.unscaled !== 0n) {
      const scale = pow10(r.scale);
      tax = inclusive
        ? divRound(net * r.unscaled, scale + r.unscaled, this.mode)
        : divRound(net * r.unscaled, scale, this.mode);
    }
    return {
      taxRuleId: null,
      taxName: r.unscaled === 0n ? 'GST Free' : 'GST',
      rate: r.unscaled === 0n ? '0.000000' : STUB_GST_RATE,
      taxableMinor: inclusive ? net - tax : net,
      taxMinor: tax,
      inclusive,
      exemptReason: r.unscaled === 0n ? 'gst_free' : null,
    };
  }
}

function quantityDecimal(quantity: string) {
  return { unscaled: parseQuantity(quantity), scale: 4 };
}

/**
 * STUB (until S-F2's catalog is wired): the variant snapshot is whatever the submitted line says.
 * Open items (no variant) and variant lines alike need a name and a list price on the request.
 */
export class StubCatalogPort implements CatalogPort {
  async resolveVariant(
    _context: CatalogLookupContext,
    line: SubmittedLine,
  ): Promise<VariantSnapshot> {
    if (!line.item?.name)
      throw ruleInvalid('LINE_ITEM_REQUIRED', 'A line needs item.name until the catalog is wired');
    if (line.listPriceMinor === null)
      throw ruleInvalid(
        'LINE_PRICE_REQUIRED',
        'A line needs listPriceMinor until the catalog is wired',
      );
    if (line.listPriceMinor < 0n)
      throw ruleInvalid('LINE_PRICE_NEGATIVE', 'listPriceMinor must not be negative');
    return {
      variantId: line.variantId,
      itemSnapshot: line.item,
      unitOfMeasure: line.unitOfMeasure ?? 'each',
      listPriceMinor: line.listPriceMinor,
    };
  }
}
