import { defaultCurrencies } from '../money/currency.js';
import { toDecimalString } from '../money/money.js';
import { localDateTime } from '../time/business-date.js';
import { displayOrderNumber } from './order-number.js';
import { isPriced } from './aggregate.js';
import { type OrderState, ruleInvalid } from './types.js';

/**
 * Receipt model and layouts (docs/03 §5 F4). Pure: the same model feeds the HTML and PDF renderers
 * on the server and the ESC/POS encoder on devices, so a reprint at an offline register matches.
 */

export const RECEIPT_KINDS = ['sale', 'refund', 'reprint', 'gift', 'proforma', 'void'] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];

export interface ReceiptMoney {
  readonly minor: bigint;
  /** Formatted for display: "$12.34", "-$1.50". */
  readonly text: string;
}

export interface ReceiptLineModel {
  readonly name: string;
  readonly sku: string | null;
  readonly quantity: string;
  readonly unitPrice: ReceiptMoney;
  readonly total: ReceiptMoney;
  readonly modifiers: readonly { readonly name: string; readonly delta: ReceiptMoney | null }[];
  readonly discount: ReceiptMoney | null;
  readonly note: string | null;
  readonly isReturn: boolean;
}

export interface TaxBreakdownRow {
  readonly name: string;
  /** "10%" or null when it mixes charge tax at an unknown rate. */
  readonly rate: string | null;
  /** Amount the tax applies to, excluding tax. */
  readonly taxable: ReceiptMoney;
  readonly tax: ReceiptMoney;
}

export interface ReceiptModel {
  readonly kind: ReceiptKind;
  readonly title: string;
  readonly number: string;
  readonly copyNumber: number | null;
  readonly businessName: string;
  readonly locationName: string;
  readonly addressLines: readonly string[];
  readonly taxRegistration: string | null;
  readonly header: string | null;
  readonly legalText: string | null;
  readonly orderNumber: string;
  readonly clientOrderRef: string | null;
  readonly orderKind: string;
  readonly checkNumber: number | null;
  readonly businessDate: string;
  readonly issuedAt: string;
  readonly currency: string;
  readonly pricing: 'inclusive' | 'exclusive';
  readonly lines: readonly ReceiptLineModel[];
  readonly discounts: readonly { readonly description: string; readonly amount: ReceiptMoney }[];
  readonly charges: readonly { readonly description: string; readonly amount: ReceiptMoney }[];
  readonly subtotal: ReceiptMoney;
  readonly discountTotal: ReceiptMoney;
  readonly chargesTotal: ReceiptMoney;
  readonly tip: ReceiptMoney | null;
  readonly rounding: ReceiptMoney | null;
  readonly total: ReceiptMoney;
  readonly paid: ReceiptMoney;
  readonly due: ReceiptMoney;
  readonly refunded: ReceiptMoney | null;
  readonly tax: readonly TaxBreakdownRow[];
  readonly taxTotal: ReceiptMoney;
}

export interface ReceiptBuildContext {
  readonly kind: ReceiptKind;
  readonly number: string;
  readonly businessName: string;
  readonly locationName: string;
  readonly addressLines?: readonly string[];
  readonly taxRegistration?: string | null;
  readonly header?: string | null;
  readonly legalText?: string | null;
  readonly timezone: string;
  readonly issuedAt: Date;
  /** Limit the receipt to one check (split bills); absent covers the whole order. */
  readonly checkId?: string | null;
  readonly copyNumber?: number | null;
  /** For a reprint: the kind of the document being reprinted (sale, refund, void), which sets the title. */
  readonly baseKind?: ReceiptKind;
}

const SYMBOLS: Record<string, string> = {
  AUD: '$',
  NZD: '$',
  USD: '$',
  CAD: '$',
  SGD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
};

export function formatMoney(minor: bigint, currency: string): string {
  const negative = minor < 0n;
  const text = toDecimalString(
    { amountMinor: negative ? -minor : minor, currency },
    defaultCurrencies,
  );
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  return `${negative ? '-' : ''}${symbol}${text}`;
}

export function formatLocal(instant: Date, timezone: string): string {
  const l = localDateTime(instant, timezone);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(l.day)}/${p(l.month)}/${p(l.year, 4)} ${p(l.hour)}:${p(l.minute)}`;
}

const TITLES: Record<ReceiptKind, string> = {
  sale: 'Receipt',
  refund: 'Refund',
  reprint: 'Receipt',
  gift: 'Gift Receipt',
  proforma: 'Proforma',
  void: 'Void',
};

function percentLabel(rate: string): string {
  const n = Number(rate) * 100;
  return `${Number.isInteger(n) ? n : Number(n.toFixed(4))}%`;
}

export function buildReceiptModel(order: OrderState, ctx: ReceiptBuildContext): ReceiptModel {
  const check = ctx.checkId ? order.checks.find((c) => c.id === ctx.checkId) : undefined;
  if (ctx.checkId && !check)
    throw ruleInvalid('CHECK_NOT_FOUND', 'The check does not exist on this order');
  const inScope = (checkId: string) => !ctx.checkId || checkId === ctx.checkId;
  const m = (minor: bigint): ReceiptMoney => ({ minor, text: formatMoney(minor, order.currency) });
  const exclusive = order.pricingMode === 'tax_exclusive';
  const gift = ctx.kind === 'gift';
  const titleKind: ReceiptKind = ctx.kind === 'reprint' ? (ctx.baseKind ?? 'sale') : ctx.kind;

  const lines = order.lines
    .filter((l) => isPriced(l) && inScope(l.checkId))
    .sort((a, b) => a.seq - b.seq)
    .map((l): ReceiptLineModel => ({
      name: l.itemSnapshot.name,
      sku: l.itemSnapshot.sku ?? null,
      quantity: trimQuantity(l.quantity),
      unitPrice: m(gift ? 0n : l.unitPriceMinor),
      total: m(gift ? 0n : l.totalMinor - (exclusive ? l.taxMinor : 0n)),
      modifiers: l.modifiers.map((x) => ({
        name: x.quantity > 1 ? `${x.quantity}x ${x.name}` : x.name,
        delta: gift || x.priceDeltaMinor === 0n ? null : m(x.priceDeltaMinor * BigInt(x.quantity)),
      })),
      discount: gift || l.discountMinor === 0n ? null : m(-l.discountMinor),
      note: l.notes,
      isReturn: l.returnOfLineId !== null,
    }));

  const discounts = order.discounts
    .filter((d) => d.orderLineId === null && !gift)
    .map((d) => ({ description: d.description, amount: m(-d.amountMinor) }));
  const charges = order.charges
    .filter((c) => inScope(c.checkId))
    .map((c) => ({ description: c.description, amount: m(gift ? 0n : c.amountMinor) }));

  // Tax breakdown: line tax rows grouped by name and rate, charge tax merged when unambiguous.
  const groups = new Map<string, { name: string; rate: string; taxable: bigint; tax: bigint }>();
  for (const l of order.lines) {
    if (!isPriced(l) || !inScope(l.checkId)) continue;
    for (const t of l.taxes) {
      const key = `${t.taxName}|${t.rate}`;
      const g = groups.get(key) ?? { name: t.taxName, rate: t.rate, taxable: 0n, tax: 0n };
      g.taxable += t.taxableMinor;
      g.tax += t.taxMinor;
      groups.set(key, g);
    }
  }
  const chargeTax = order.charges
    .filter((c) => inScope(c.checkId))
    .reduce((a, c) => a + c.taxMinor, 0n);
  const chargeTaxable = order.charges
    .filter((c) => inScope(c.checkId) && c.taxMinor !== 0n)
    .reduce((a, c) => a + (exclusive ? c.amountMinor : c.amountMinor - c.taxMinor), 0n);
  const rows: TaxBreakdownRow[] = [...groups.values()].map((g) => ({
    name: g.name,
    rate: percentLabel(g.rate),
    taxable: m(g.taxable),
    tax: m(g.tax),
  }));
  if (chargeTax !== 0n) {
    const taxed = [...groups.values()].filter((g) => Number(g.rate) > 0);
    if (taxed.length === 1) {
      const g = taxed[0]!;
      const i = rows.findIndex((r) => r.name === g.name && r.rate === percentLabel(g.rate));
      rows[i] = { ...rows[i]!, taxable: m(g.taxable + chargeTaxable), tax: m(g.tax + chargeTax) };
    } else
      rows.push({
        name: 'Tax on charges',
        rate: null,
        taxable: m(chargeTaxable),
        tax: m(chargeTax),
      });
  }
  const taxTotal = rows.reduce((a, r) => a + r.tax.minor, 0n);

  const scope = check ?? order;
  const orderNumber = displayOrderNumber(order);
  return {
    kind: ctx.kind,
    title:
      ctx.taxRegistration && titleKind === 'sale' && taxTotal !== 0n
        ? 'Tax Invoice'
        : TITLES[titleKind],
    number: ctx.number,
    copyNumber: ctx.copyNumber ?? null,
    businessName: ctx.businessName,
    locationName: ctx.locationName,
    addressLines: ctx.addressLines ?? [],
    taxRegistration: ctx.taxRegistration ?? null,
    header: ctx.header ?? null,
    legalText: ctx.legalText ?? null,
    orderNumber,
    clientOrderRef: order.clientOrderRef,
    orderKind: order.kind,
    checkNumber: check?.number ?? null,
    businessDate: order.businessDate,
    issuedAt: formatLocal(ctx.issuedAt, ctx.timezone),
    currency: order.currency,
    pricing: exclusive ? 'exclusive' : 'inclusive',
    lines,
    discounts,
    charges,
    subtotal: m(gift ? 0n : scope.subtotalMinor),
    discountTotal: m(gift ? 0n : -scope.discountMinor),
    chargesTotal: m(gift ? 0n : scope.chargesMinor),
    tip: !gift && scope.tipMinor !== 0n ? m(scope.tipMinor) : null,
    rounding: !gift && scope.roundingMinor !== 0n ? m(scope.roundingMinor) : null,
    total: m(gift ? 0n : scope.totalMinor),
    paid: m(gift ? 0n : scope.paidMinor),
    due: m(gift ? 0n : scope.totalMinor - scope.paidMinor),
    refunded: !gift && scope.refundedMinor !== 0n ? m(scope.refundedMinor) : null,
    tax: gift ? [] : rows,
    taxTotal: m(gift ? 0n : taxTotal),
  };
}

function trimQuantity(q: string): string {
  const [i, f = ''] = q.split('.');
  const frac = f.replace(/0+$/, '');
  return frac ? `${i}.${frac}` : (i ?? q);
}

// ---------------------------------------------------------------------------
// Layout: fixed-width lines shared by plain text, ESC/POS and the PDF renderer
// ---------------------------------------------------------------------------

export interface LayoutLine {
  readonly text: string;
  readonly align?: 'left' | 'center' | 'right';
  readonly bold?: boolean;
  /** Double width and height. */
  readonly large?: boolean;
}

export const DEFAULT_COLUMNS = 48; // 80 mm paper, font A. 58 mm paper: 32.

/** ASCII-only (CP437-safe) text: accents stripped, symbols spelled out. */
export function toPrinterText(text: string): string {
  return text
    .replaceAll('€', 'EUR ')
    .replaceAll('£', 'GBP ')
    .replaceAll('¥', 'JPY ')
    .replaceAll('—', '-')
    .replaceAll('–', '-')
    .replaceAll('“', '"')
    .replaceAll('”', '"')
    .replaceAll('’', "'")
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '?');
}

function twoCol(left: string, right: string, columns: number): string {
  const space = columns - right.length - 1;
  const l = left.length > space ? left.slice(0, Math.max(0, space)) : left;
  return `${l}${' '.repeat(Math.max(1, columns - l.length - right.length))}${right}`;
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of toPrinterText(text).split('\n')) {
    let line = '';
    for (const word of raw.split(/\s+/)) {
      if (!word) continue;
      if (line && line.length + 1 + word.length > width) {
        out.push(line);
        line = '';
      }
      line = line ? `${line} ${word}` : word;
      while (line.length > width) {
        out.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    out.push(line);
  }
  return out;
}

export function layoutReceipt(model: ReceiptModel, columns = DEFAULT_COLUMNS): LayoutLine[] {
  const out: LayoutLine[] = [];
  const rule = (ch = '-') => out.push({ text: ch.repeat(columns) });
  const center = (text: string, opts: Partial<LayoutLine> = {}) =>
    wrap(text, columns).forEach((t) => out.push({ text: t, align: 'center', ...opts }));
  const row = (left: string, right: string, opts: Partial<LayoutLine> = {}) =>
    out.push({ text: twoCol(toPrinterText(left), toPrinterText(right), columns), ...opts });

  center(model.businessName, { bold: true, large: columns >= 40 });
  if (model.locationName !== model.businessName) center(model.locationName);
  model.addressLines.forEach((l) => center(l));
  if (model.taxRegistration) center(`ABN ${model.taxRegistration}`);
  if (model.header) center(model.header);
  rule();
  center(model.title.toUpperCase(), { bold: true });
  if (model.kind === 'reprint')
    center(`*** REPRINT${model.copyNumber ? ` - COPY ${model.copyNumber}` : ''} ***`, {
      bold: true,
    });
  if (model.kind === 'proforma') center('NOT A TAX INVOICE');
  if (model.kind === 'void' || model.title === 'Void')
    center('*** ORDER VOIDED ***', { bold: true });
  row('Receipt', model.number);
  row('Order', `#${model.orderNumber}${model.checkNumber ? ` check ${model.checkNumber}` : ''}`);
  if (model.clientOrderRef) row('Register ref', model.clientOrderRef);
  row('Date', model.issuedAt);
  rule();

  for (const l of model.lines) {
    const qty = l.quantity === '1' ? '' : `${l.quantity} x `;
    row(`${qty}${l.name}`, l.total.text, l.isReturn ? { bold: true } : {});
    if (l.quantity !== '1' && !l.isReturn)
      out.push({ text: `  @ ${toPrinterText(l.unitPrice.text)} each` });
    for (const x of l.modifiers) row(`  + ${x.name}`, x.delta ? x.delta.text : '');
    if (l.discount) row('  Discount', l.discount.text);
    if (l.note) wrap(`  Note: ${l.note}`, columns).forEach((t) => out.push({ text: t }));
  }
  rule();
  row('Subtotal', model.subtotal.text);
  for (const d of model.discounts) row(d.description, d.amount.text);
  if (model.discountTotal.minor !== 0n && model.discounts.length === 0)
    row('Discounts', model.discountTotal.text);
  for (const c of model.charges) row(c.description, c.amount.text);
  if (model.pricing === 'exclusive' && model.taxTotal.minor !== 0n) row('Tax', model.taxTotal.text);
  if (model.tip) row('Tip', model.tip.text);
  if (model.rounding) row('Rounding', model.rounding.text);
  row('TOTAL', model.total.text, { bold: true, large: columns >= 40 });
  if (model.paid.minor !== 0n) row('Paid', model.paid.text);
  if (model.due.minor !== 0n) row('Amount due', model.due.text, { bold: true });
  if (model.refunded) row('Refunded', model.refunded.text);
  if (model.tax.length > 0) {
    rule();
    if (model.pricing === 'inclusive' && model.taxTotal.minor !== 0n)
      row(
        `Total includes ${model.tax.find((t) => t.tax.minor !== 0n)?.name ?? model.tax[0]!.name}`,
        model.taxTotal.text,
        { bold: true },
      );
    out.push({ text: twoCol('Tax', 'Taxable      Tax', columns) });
    for (const t of model.tax) {
      const label = `${t.name}${t.rate ? ` ${t.rate}` : ''}`;
      const amounts = `${t.taxable.text.padStart(10)} ${t.tax.text.padStart(8)}`;
      out.push({ text: twoCol(toPrinterText(label), amounts, columns) });
    }
  }
  if (model.legalText) {
    rule();
    wrap(model.legalText, columns).forEach((t) => out.push({ text: t, align: 'center' }));
  }
  out.push({ text: '' });
  return out;
}

function align(line: LayoutLine, columns: number): string {
  const text = line.text.length > columns ? line.text.slice(0, columns) : line.text;
  if (line.align === 'center')
    return text
      .padStart(Math.floor((columns + text.length) / 2))
      .padEnd(columns)
      .trimEnd();
  if (line.align === 'right') return text.padStart(columns);
  return text;
}

export function renderPlainText(lines: readonly LayoutLine[], columns = DEFAULT_COLUMNS): string {
  return lines.map((l) => align(l, columns)).join('\n') + '\n';
}

/** ESC/POS command bytes: init, per-line alignment/bold/size, feed and partial cut. */
export function renderEscPos(lines: readonly LayoutLine[], columns = DEFAULT_COLUMNS): Uint8Array {
  const bytes: number[] = [0x1b, 0x40]; // ESC @ initialise
  let currentAlign = -1;
  let bold = false;
  let large = false;
  const push = (...b: number[]) => bytes.push(...b);
  for (const line of lines) {
    const alignCode = line.align === 'center' ? 1 : line.align === 'right' ? 2 : 0;
    // Large lines are half as wide; keep the layout by printing at the line's own width.
    const text = toPrinterText(line.text);
    if (alignCode !== currentAlign) {
      push(0x1b, 0x61, alignCode); // ESC a n
      currentAlign = alignCode;
    }
    const wantBold = line.bold === true;
    if (wantBold !== bold) {
      push(0x1b, 0x45, wantBold ? 1 : 0); // ESC E n
      bold = wantBold;
    }
    const wantLarge = line.large === true;
    if (wantLarge !== large) {
      push(0x1d, 0x21, wantLarge ? 0x11 : 0x00); // GS ! n
      large = wantLarge;
    }
    const printable = line.align === 'center' || line.align === 'right' ? text.trim() : text;
    for (const ch of printable.slice(0, wantLarge ? Math.floor(columns / 2) : columns))
      push(ch.charCodeAt(0));
    push(0x0a);
  }
  push(0x1b, 0x45, 0, 0x1d, 0x21, 0x00, 0x1b, 0x61, 0); // reset styles
  push(0x1b, 0x64, 4); // feed 4 lines
  push(0x1d, 0x56, 0x42, 0x00); // GS V 66 0: feed to cut position, partial cut
  return Uint8Array.from(bytes);
}
