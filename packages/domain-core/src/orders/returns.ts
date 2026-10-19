import { divRound } from '../money/decimal.js';
import { createOrder, finish, findLine, replaceCheck, sumChecks } from './aggregate.js';
import type { CommandContext } from './context.js';
import { placeCommon, type PlaceInput } from './lifecycle.js';
import { derivePaymentStatus } from './payments.js';
import { canonicalQuantity, formatQuantity, parseQuantity } from './quantity.js';
import { assertPaymentTransition } from './status.js';
import {
  type OrderChannel,
  type OrderLine,
  type OrderState,
  type ReducerResult,
  isReturnKind,
  ruleConflict,
  ruleInvalid,
} from './types.js';

export interface ReturnLineInput {
  readonly sourceLineId: string;
  readonly quantity: string;
  readonly reason?: string | null;
}

export interface BuildReturnInput {
  readonly kind: 'return' | 'exchange';
  readonly lines: readonly ReturnLineInput[];
  readonly reason?: string | null;
  readonly registerId?: string | null;
  readonly deviceId?: string | null;
  readonly channel?: OrderChannel;
  readonly businessDate: string;
  readonly clientOrderRef?: string | null;
  readonly clientCreatedAt?: string | null;
  readonly notes?: string | null;
}

/**
 * What the customer gets back for `quantity` more units of a source line, in minor units, before
 * tax for exclusive pricing and tax-included for inclusive pricing. Computed on the running total
 * (round(net × returned_after / qty) − round(net × returned_before / qty)) so partial returns add
 * up to the amount paid and a full return refunds exactly the line's net.
 */
export function returnRefundMinor(
  source: OrderState,
  line: OrderLine,
  alreadyScaled: bigint,
  quantityScaled: bigint,
): bigint {
  const net = line.totalMinor - (source.pricingMode === 'tax_exclusive' ? line.taxMinor : 0n);
  const total = parseQuantity(line.quantity);
  return (
    divRound(net * (alreadyScaled + quantityScaled), total, 'HALF_UP') -
    divRound(net * alreadyScaled, total, 'HALF_UP')
  );
}

function assertReturnable(source: OrderState): void {
  if (source.status !== 'completed')
    throw ruleConflict(
      'SOURCE_NOT_COMPLETED',
      `Only a completed order can be returned (order is ${source.status})`,
      {
        status: source.status,
      },
    );
  if (source.kind === 'return')
    throw ruleConflict('SOURCE_IS_RETURN', 'A return order cannot itself be returned');
}

function returnLine(
  source: OrderState,
  src: OrderLine,
  quantityScaled: bigint,
  already: bigint,
  reason: string | null,
  seq: number,
  checkId: string,
  ctx: CommandContext,
): OrderLine {
  const refund = returnRefundMinor(source, src, already, quantityScaled);
  return {
    ...src,
    id: ctx.newId(),
    checkId,
    seq,
    parentLineId: null,
    quantity: formatQuantity(quantityScaled),
    unitPriceMinor: -src.unitPriceMinor,
    priceOverrideReason: null,
    priceOverrideApprovalId: null,
    modifiers: src.modifiers.map((m) => ({ ...m, id: ctx.newId() })),
    discountMinor: 0n,
    taxMinor: 0n,
    totalMinor: 0n,
    taxes: [],
    status: 'active',
    voidReason: null,
    voidedBy: null,
    voidApprovalId: null,
    voidedAt: null,
    kitchenStatus: null,
    fulfillmentMode: 'take',
    returnOfLineId: src.id,
    returnedQuantity: '0.0000',
    grossOverrideMinor: -refund,
    metadata: { returnReason: reason, sourceOrderId: source.id, sourceSeq: src.seq },
    createdAt: ctx.now,
  };
}

/**
 * Build a draft return (or exchange) order whose lines reference the original lines
 * (`return_of_line_id`); the original order is never changed here. An exchange continues as a
 * normal draft: add the new items with addLine, then place.
 */
export function buildReturnOrder(
  source: OrderState,
  input: BuildReturnInput,
  ctx: CommandContext,
): ReducerResult {
  assertReturnable(source);
  if (input.lines.length === 0)
    throw ruleInvalid('RETURN_EMPTY', 'Name at least one line to return');
  const seen = new Set<string>();
  const created = createOrder(
    {
      tenantId: source.tenantId,
      locationId: source.locationId,
      registerId: input.registerId ?? source.registerId,
      deviceId: input.deviceId ?? null,
      businessDate: input.businessDate,
      kind: input.kind,
      channel: input.channel ?? source.channel,
      currency: source.currency,
      pricingMode: source.pricingMode,
      customerId: source.customerId,
      sourceOrderId: source.id,
      clientOrderRef: input.clientOrderRef ?? null,
      clientCreatedAt: input.clientCreatedAt ?? null,
      notes: input.notes ?? null,
      metadata: { returnReason: input.reason ?? null },
    },
    ctx,
  );
  let order = created.state;
  const checkId = order.checks[0]!.id;
  const lines: OrderLine[] = [];
  for (const item of input.lines) {
    if (seen.has(item.sourceLineId))
      throw ruleInvalid('RETURN_LINE_DUPLICATE', 'A source line appears twice', {
        sourceLineId: item.sourceLineId,
      });
    seen.add(item.sourceLineId);
    const src = findLine(source, item.sourceLineId);
    if (src.returnOfLineId !== null)
      throw ruleConflict('SOURCE_LINE_IS_RETURN', 'A returned line cannot be returned again', {
        lineId: src.id,
      });
    if (src.status !== 'active' && src.status !== 'returned')
      throw ruleConflict('SOURCE_LINE_NOT_RETURNABLE', `The line is ${src.status}`, {
        lineId: src.id,
      });
    const q = parseQuantity(item.quantity);
    if (q <= 0n) throw ruleInvalid('QUANTITY_INVALID', 'Quantity must be greater than zero');
    const already = parseQuantity(src.returnedQuantity);
    const remaining = parseQuantity(src.quantity) - already;
    if (q > remaining)
      throw ruleConflict('RETURN_QUANTITY_EXCEEDED', 'More than is left to return', {
        lineId: src.id,
        remaining: formatQuantity(remaining),
        requested: canonicalQuantity(item.quantity),
      });
    lines.push(
      returnLine(
        source,
        src,
        q,
        already,
        item.reason ?? input.reason ?? null,
        lines.length + 1,
        checkId,
        ctx,
      ),
    );
  }
  order = { ...order, lines };
  const result = finish(created.state, order, ctx, []);
  return {
    // `finish` bumped the version; a brand-new order starts at 1.
    state: {
      ...result.state,
      version: 1,
      checks: result.state.checks.map((c) => ({ ...c, version: 1 })),
    },
    events: [
      ...created.events,
      {
        kind: 'line_added',
        payload: {
          returnedLines: lines.map((l) => ({
            lineId: l.id,
            returnOfLineId: l.returnOfLineId,
            quantity: l.quantity,
          })),
        },
      },
    ],
  };
}

export interface PlaceReturnResult extends ReducerResult {
  readonly source: OrderState;
  readonly sourceEvents: ReducerResult['events'];
}

/**
 * Place a return/exchange: assigns the canonical number and reserves the returned quantity on the
 * source order's lines (`returned_quantity`, status `returned` when fully returned) in the same step.
 * `source` must be the locked, current source order.
 */
export function placeReturn(
  order: OrderState,
  source: OrderState,
  input: PlaceInput,
  ctx: CommandContext,
): PlaceReturnResult {
  if (!isReturnKind(order.kind) || order.sourceOrderId !== source.id)
    throw ruleConflict('SOURCE_MISMATCH', 'The source order does not belong to this return');
  assertReturnable(source);
  if (order.status !== 'draft')
    throw ruleConflict('ORDER_NOT_DRAFT', 'Only a draft order is placed');

  // Re-derive each return line's refund from the source as it is now (another return may have landed since).
  const running = new Map<string, bigint>();
  let sourceLines = source.lines;
  const lines = order.lines.map((l) => {
    if (!l.returnOfLineId || l.status !== 'active') return l;
    const src = sourceLines.find((s) => s.id === l.returnOfLineId);
    if (!src)
      throw ruleConflict('SOURCE_MISMATCH', 'A returned line no longer exists on the source order');
    const already = running.get(src.id) ?? parseQuantity(src.returnedQuantity);
    const q = parseQuantity(l.quantity);
    if (already + q > parseQuantity(src.quantity))
      throw ruleConflict('RETURN_QUANTITY_EXCEEDED', 'More than is left to return', {
        lineId: src.id,
        remaining: formatQuantity(parseQuantity(src.quantity) - already),
      });
    running.set(src.id, already + q);
    return { ...l, grossOverrideMinor: -returnRefundMinor(source, src, already, q) };
  });
  sourceLines = source.lines.map((s) => {
    const total = running.get(s.id);
    if (total === undefined) return s;
    return {
      ...s,
      returnedQuantity: formatQuantity(total),
      status: total === parseQuantity(s.quantity) ? ('returned' as const) : s.status,
    };
  });

  const placed = placeCommon({ ...order, lines }, input, ctx);
  const updatedSource: OrderState = {
    ...source,
    lines: sourceLines,
    version: source.version + 1,
    updatedAt: ctx.now,
  };
  return {
    state: placed.state,
    events: placed.events,
    source: updatedSource,
    sourceEvents: [
      {
        kind: 'returned',
        payload: {
          returnOrderId: order.id,
          kind: order.kind,
          lines: [...running.entries()].map(([lineId, q]) => ({
            lineId,
            returnedQuantity: formatQuantity(q),
          })),
        },
      },
    ],
  };
}

/** Undo the reservation when a placed return is cancelled. */
export function releaseReturn(
  order: OrderState,
  source: OrderState,
  ctx: CommandContext,
): ReducerResult {
  const give = new Map<string, bigint>();
  for (const l of order.lines) {
    if (l.returnOfLineId && (l.status === 'active' || l.status === 'cancelled'))
      give.set(l.returnOfLineId, (give.get(l.returnOfLineId) ?? 0n) + parseQuantity(l.quantity));
  }
  const lines = source.lines.map((s) => {
    const back = give.get(s.id);
    if (back === undefined) return s;
    const left = parseQuantity(s.returnedQuantity) - back;
    return {
      ...s,
      returnedQuantity: formatQuantity(left < 0n ? 0n : left),
      status: s.status === 'returned' ? ('active' as const) : s.status,
    };
  });
  return {
    state: { ...source, lines, version: source.version + 1, updatedAt: ctx.now },
    events: [{ kind: 'return_released', payload: { returnOrderId: order.id } }],
  };
}

/**
 * A completed return/exchange refunds its returned lines to the source order: each source check
 * records the refunded amount, and the source's payment_status moves to partially_refunded / refunded.
 */
export function applyReturnRefundToSource(
  returnOrder: OrderState,
  source: OrderState,
  ctx: CommandContext,
): ReducerResult {
  const byCheck = new Map<string, bigint>();
  for (const l of returnOrder.lines) {
    if (l.status !== 'active' || !l.returnOfLineId) continue;
    const src = source.lines.find((s) => s.id === l.returnOfLineId);
    if (!src) continue;
    const refunded = -l.totalMinor; // return lines are negative
    byCheck.set(src.checkId, (byCheck.get(src.checkId) ?? 0n) + (refunded > 0n ? refunded : 0n));
  }
  let next = source;
  const applied: { checkId: string; amountMinor: string }[] = [];
  for (const [checkId, amount] of byCheck) {
    const check = next.checks.find((c) => c.id === checkId);
    if (!check) continue;
    const room = check.paidMinor - check.refundedMinor;
    const take = amount > room ? room : amount;
    if (take <= 0n) continue;
    next = replaceCheck(next, {
      ...check,
      refundedMinor: check.refundedMinor + take,
      version: check.version + 1,
    });
    applied.push({ checkId, amountMinor: take.toString() });
  }
  next = { ...next, ...sumChecks(next.checks) };
  const status = derivePaymentStatus(next);
  assertPaymentTransition(source.paymentStatus, status);
  return {
    state: { ...next, paymentStatus: status, version: source.version + 1, updatedAt: ctx.now },
    events: [
      {
        kind: 'refund_applied',
        payload: { returnOrderId: returnOrder.id, checks: applied, paymentStatus: status },
      },
    ],
  };
}
