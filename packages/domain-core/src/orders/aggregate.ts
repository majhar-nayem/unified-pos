import { mulDecimal } from '../money/decimal.js';
import { assertClientOrderRef } from './order-number.js';
import { parseQuantity } from './quantity.js';
import type { CommandContext } from './context.js';
import type { PricingChargeRequest, PricingDiscountRequest, PricingLineRequest } from './ports.js';
import {
  type Check,
  type FulfillmentMode,
  type FulfillmentStatus,
  type OrderChannel,
  type OrderEvent,
  type OrderKind,
  type OrderLine,
  type OrderState,
  type PricingMode,
  type ReducerResult,
  isReturnKind,
  ORDER_CHANNELS,
  ORDER_KINDS,
  PRICING_MODES,
  ruleConflict,
  ruleInvalid,
  ruleNotFound,
} from './types.js';

export interface CreateOrderInput {
  readonly id?: string;
  readonly tenantId: string;
  readonly locationId: string;
  readonly registerId?: string | null;
  readonly deviceId?: string | null;
  readonly businessDate: string;
  readonly kind: OrderKind;
  readonly channel?: OrderChannel;
  readonly currency: string;
  readonly pricingMode?: PricingMode;
  readonly priceListId?: string | null;
  readonly configVersion?: number | null;
  readonly customerId?: string | null;
  readonly tableSessionId?: string | null;
  readonly guestCount?: number | null;
  readonly employeeId?: string | null;
  readonly clientOrderRef?: string | null;
  readonly clientCreatedAt?: string | null;
  readonly sourceOrderId?: string | null;
  readonly externalRef?: string | null;
  readonly scheduledFor?: string | null;
  readonly notes?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Create a draft order with its default check. Return/exchange orders must name their source. */
export function createOrder(input: CreateOrderInput, ctx: CommandContext): ReducerResult {
  if (!ORDER_KINDS.includes(input.kind))
    throw ruleInvalid('ORDER_KIND_INVALID', `Unknown order kind ${String(input.kind)}`);
  const channel = input.channel ?? 'pos';
  if (!ORDER_CHANNELS.includes(channel))
    throw ruleInvalid('ORDER_CHANNEL_INVALID', `Unknown channel ${String(channel)}`);
  const pricingMode = input.pricingMode ?? 'tax_inclusive';
  if (!PRICING_MODES.includes(pricingMode))
    throw ruleInvalid('PRICING_MODE_INVALID', `Unknown pricing mode ${String(pricingMode)}`);
  if (!/^[A-Z]{3}$/.test(input.currency))
    throw ruleInvalid('CURRENCY_INVALID', 'currency must be an ISO 4217 code');
  if (isReturnKind(input.kind) && !input.sourceOrderId)
    throw ruleInvalid(
      'RETURN_REQUIRES_SOURCE',
      `A ${input.kind} order must reference its source order`,
    );
  if (!isReturnKind(input.kind) && input.sourceOrderId)
    throw ruleInvalid(
      'SOURCE_ONLY_ON_RETURN',
      'Only return and exchange orders have a source order',
    );
  if (input.clientOrderRef) assertClientOrderRef(input.clientOrderRef);
  if (input.guestCount != null && (!Number.isInteger(input.guestCount) || input.guestCount < 0))
    throw ruleInvalid('GUEST_COUNT_INVALID', 'guestCount must be a non-negative integer');

  const id = input.id ?? ctx.newId();
  const check: Check = emptyCheck(ctx.newId(), 1, null);
  const fulfillmentStatus: FulfillmentStatus = isReturnKind(input.kind)
    ? 'not_applicable'
    : 'unfulfilled';
  const state: OrderState = {
    id,
    tenantId: input.tenantId,
    locationId: input.locationId,
    registerId: input.registerId ?? null,
    deviceId: input.deviceId ?? ctx.deviceId ?? null,
    orderNumber: null,
    clientOrderRef: input.clientOrderRef ?? null,
    businessDate: input.businessDate,
    kind: input.kind,
    channel,
    status: 'draft',
    fulfillmentStatus,
    paymentStatus: 'unpaid',
    customerId: input.customerId ?? null,
    tableSessionId: input.tableSessionId ?? null,
    guestCount: input.guestCount ?? null,
    employeeId: input.employeeId ?? null,
    currency: input.currency,
    pricingMode,
    priceListId: input.priceListId ?? null,
    configVersion: input.configVersion ?? null,
    subtotalMinor: 0n,
    discountMinor: 0n,
    taxMinor: 0n,
    chargesMinor: 0n,
    tipMinor: 0n,
    roundingMinor: 0n,
    totalMinor: 0n,
    paidMinor: 0n,
    refundedMinor: 0n,
    sourceOrderId: input.sourceOrderId ?? null,
    externalRef: input.externalRef ?? null,
    scheduledFor: input.scheduledFor ?? null,
    notes: input.notes ?? null,
    metadata: input.metadata ?? {},
    placedAt: null,
    completedAt: null,
    cancelledAt: null,
    voidedAt: null,
    voidReason: null,
    voidApprovalId: null,
    reopenedAt: null,
    reopenedReason: null,
    clientCreatedAt: input.clientCreatedAt ?? null,
    syncedAt: input.clientCreatedAt ? ctx.now : null,
    settlementPending: false,
    version: 1,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    checks: [check],
    lines: [],
    discounts: [],
    charges: [],
  };
  return {
    state,
    events: [
      {
        kind: 'created',
        toStatus: 'draft',
        payload: {
          kind: state.kind,
          channel: state.channel,
          clientOrderRef: state.clientOrderRef,
          businessDate: state.businessDate,
          sourceOrderId: state.sourceOrderId,
        },
      },
    ],
  };
}

export function emptyCheck(id: string, number: number, label: string | null): Check {
  return {
    id,
    number,
    label,
    status: 'open',
    subtotalMinor: 0n,
    discountMinor: 0n,
    taxMinor: 0n,
    chargesMinor: 0n,
    tipMinor: 0n,
    roundingMinor: 0n,
    totalMinor: 0n,
    paidMinor: 0n,
    refundedMinor: 0n,
    closedAt: null,
    closedBy: null,
    version: 1,
  };
}

// ---------------------------------------------------------------------------
// Lookups and immutable updates
// ---------------------------------------------------------------------------

export function findLine(order: OrderState, lineId: string): OrderLine {
  const line = order.lines.find((l) => l.id === lineId);
  if (!line) throw ruleNotFound('LINE_NOT_FOUND', 'The line does not exist on this order');
  return line;
}

export function findCheck(order: OrderState, checkId: string): Check {
  const check = order.checks.find((c) => c.id === checkId);
  if (!check) throw ruleNotFound('CHECK_NOT_FOUND', 'The check does not exist on this order');
  return check;
}

export function replaceLine(order: OrderState, line: OrderLine): OrderState {
  return { ...order, lines: order.lines.map((l) => (l.id === line.id ? line : l)) };
}

export function replaceCheck(order: OrderState, check: Check): OrderState {
  return { ...order, checks: order.checks.map((c) => (c.id === check.id ? check : c)) };
}

/** Active and returned lines are billed; voided and cancelled lines are history. */
export function isPriced(line: OrderLine): boolean {
  return line.status === 'active' || line.status === 'returned';
}

/** quantity × (unit price + modifiers), or the fixed gross of a shared portion / returned line. */
export function lineGrossMinor(line: OrderLine): bigint {
  if (line.grossOverrideMinor !== null) return line.grossOverrideMinor;
  return mulDecimal(
    line.unitPriceMinor + modifiersDelta(line),
    { unscaled: parseQuantity(line.quantity), scale: 4 },
    'HALF_UP',
  );
}

export function modifiersDelta(line: Pick<OrderLine, 'modifiers'>): bigint {
  return line.modifiers.reduce((acc, m) => acc + m.priceDeltaMinor * BigInt(m.quantity), 0n);
}

/** A check that already took money is frozen: its lines, charges and discounts no longer change. */
export function assertCheckMutable(order: OrderState, checkId: string): Check {
  const check = findCheck(order, checkId);
  if (check.status !== 'open')
    throw ruleConflict('CHECK_NOT_OPEN', `Check ${check.number} is ${check.status}`, { checkId });
  if (check.paidMinor !== 0n)
    throw ruleConflict('CHECK_HAS_PAYMENTS', `Check ${check.number} already has payments`, {
      checkId,
    });
  return check;
}

export function defaultFulfillmentMode(kind: OrderKind): FulfillmentMode {
  switch (kind) {
    case 'dine_in':
      return 'dine_in';
    case 'delivery':
      return 'deliver';
    case 'pickup':
      return 'pickup';
    default:
      return 'take';
  }
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

/**
 * Recompute every derived amount through the pricing port: line discounts, tax rows, charge
 * amounts, then per-check and order totals. Totals are denormalised and recomputed on every
 * mutation, never by SQL triggers, so devices and server agree (docs/02 §3.6).
 */
export function recompute(order: OrderState, ctx: Pick<CommandContext, 'pricing'>): OrderState {
  const priced = order.lines.filter(isPriced);
  const pricedIds = new Set(priced.map((l) => l.id));

  const lines: PricingLineRequest[] = priced.map((l) => ({
    id: l.id,
    quantity: l.quantity,
    unitPriceMinor: l.unitPriceMinor + modifiersDelta(l),
    grossOverrideMinor: l.grossOverrideMinor,
    variantId: l.variantId,
    taxClassCode: l.itemSnapshot.taxClassCode ?? null,
  }));
  const liveDiscounts = order.discounts.filter(
    (d) => d.orderLineId === null || pricedIds.has(d.orderLineId),
  );
  const discounts: PricingDiscountRequest[] = liveDiscounts.map((d) => ({
    id: d.id,
    kind: d.kind,
    lineId: d.orderLineId,
    percent: d.percent,
    amountMinor: d.percent === null ? d.amountMinor : 0n,
  }));
  const liveCharges = order.charges.filter(
    (c) => order.checks.find((k) => k.id === c.checkId)?.status !== 'voided',
  );
  const charges: PricingChargeRequest[] = liveCharges.map((c) => ({
    id: c.id,
    kind: c.kind,
    amountMinor: c.percent === null ? c.amountMinor : 0n,
    percent: c.percent,
    taxable: c.taxable,
    appliesToLineIds: priced.filter((l) => l.checkId === c.checkId).map((l) => l.id),
  }));

  const result = ctx.pricing.priceOrder({
    currency: order.currency,
    pricingMode: order.pricingMode,
    locationId: order.locationId,
    customerId: order.customerId,
    priceListId: order.priceListId,
    at: order.placedAt ?? order.createdAt,
    businessDate: order.businessDate,
    lines,
    discounts,
    charges,
  });

  const lineResult = new Map(result.lines.map((l) => [l.id, l]));
  const discountResult = new Map(result.discounts.map((d) => [d.id, d]));
  const chargeResult = new Map(result.charges.map((c) => [c.id, c]));

  const newLines = order.lines.map((l) => {
    const r = lineResult.get(l.id);
    if (!r) return l;
    return {
      ...l,
      discountMinor: r.discountMinor,
      taxMinor: r.taxMinor,
      totalMinor: r.totalMinor,
      taxes: r.taxes,
    };
  });
  const newDiscounts = order.discounts.map((d) => {
    const r = discountResult.get(d.id);
    return r ? { ...d, amountMinor: r.amountMinor, trace: r.trace ?? d.trace } : d;
  });
  const newCharges = order.charges.map((c) => {
    const r = chargeResult.get(c.id);
    return r ? { ...c, amountMinor: r.amountMinor, taxMinor: r.taxMinor } : c;
  });

  const exclusive = order.pricingMode === 'tax_exclusive';
  const checks = order.checks.map((check): Check => {
    if (check.status === 'voided')
      return {
        ...check,
        subtotalMinor: 0n,
        discountMinor: 0n,
        taxMinor: 0n,
        chargesMinor: 0n,
        totalMinor: 0n,
      };
    let subtotal = 0n;
    let discount = 0n;
    let tax = 0n;
    for (const l of priced) {
      if (l.checkId !== check.id) continue;
      const r = lineResult.get(l.id)!;
      subtotal += r.grossMinor;
      discount += r.discountMinor;
      tax += r.taxMinor;
    }
    let chargesTotal = 0n;
    for (const c of newCharges) {
      if (c.checkId !== check.id) continue;
      if (!liveCharges.some((x) => x.id === c.id)) continue;
      chargesTotal += c.amountMinor;
      tax += c.taxMinor;
    }
    const total =
      subtotal -
      discount +
      (exclusive ? tax : 0n) +
      chargesTotal +
      check.tipMinor +
      check.roundingMinor;
    return {
      ...check,
      subtotalMinor: subtotal,
      discountMinor: discount,
      taxMinor: tax,
      chargesMinor: chargesTotal,
      totalMinor: total,
    };
  });

  return {
    ...order,
    lines: newLines,
    discounts: newDiscounts,
    charges: newCharges,
    checks,
    ...sumChecks(checks),
  };
}

export function sumChecks(checks: readonly Check[]) {
  const sum = (pick: (c: Check) => bigint) => checks.reduce((a, c) => a + pick(c), 0n);
  return {
    subtotalMinor: sum((c) => c.subtotalMinor),
    discountMinor: sum((c) => c.discountMinor),
    taxMinor: sum((c) => c.taxMinor),
    chargesMinor: sum((c) => c.chargesMinor),
    tipMinor: sum((c) => c.tipMinor),
    roundingMinor: sum((c) => c.roundingMinor),
    totalMinor: sum((c) => c.totalMinor),
    paidMinor: sum((c) => c.paidMinor),
    refundedMinor: sum((c) => c.refundedMinor),
  };
}

/** Recompute, bump the order (and every changed check) version, stamp updatedAt. */
export function finish(
  before: OrderState,
  after: OrderState,
  ctx: Pick<CommandContext, 'pricing' | 'now'>,
  events: readonly OrderEvent[],
): ReducerResult {
  const priced = recompute(after, ctx);
  const checks = priced.checks.map((c) => {
    const old = before.checks.find((o) => o.id === c.id);
    return old && sameCheck(old, c) ? c : { ...c, version: (old?.version ?? 0) + 1 };
  });
  const state: OrderState = {
    ...priced,
    checks,
    version: before.version + 1,
    updatedAt: ctx.now,
  };
  return { state, events };
}

function sameCheck(a: Check, b: Check): boolean {
  const { version: _va, ...ra } = a;
  const { version: _vb, ...rb } = b;
  return JSON.stringify(ra, bigintReplacer) === JSON.stringify(rb, bigintReplacer);
}

export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
