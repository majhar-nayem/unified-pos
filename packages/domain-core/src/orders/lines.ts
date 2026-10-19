import {
  assertCheckMutable,
  defaultFulfillmentMode,
  emptyCheck,
  finish,
  findLine,
  isPriced,
  modifiersDelta,
  replaceLine,
} from './aggregate.js';
import type { CommandContext } from './context.js';
import type { VariantSnapshot } from './ports.js';
import { canonicalQuantity, parseQuantity, ZERO_QUANTITY } from './quantity.js';
import { assertEditable } from './status.js';
import {
  type Check,
  type FulfillmentMode,
  type KitchenStatus,
  type LineModifier,
  type OrderLine,
  type OrderState,
  type ReducerResult,
  FULFILLMENT_MODES,
  ruleConflict,
  ruleInvalid,
} from './types.js';

export interface ModifierInput {
  readonly modifierId?: string | null;
  readonly groupName?: string | null;
  readonly name: string;
  readonly kind?: string;
  readonly quantity?: number;
  readonly priceDeltaMinor?: bigint;
}

export interface AddLineInput {
  readonly id?: string;
  /** Resolved through CatalogPort by the caller. */
  readonly snapshot: VariantSnapshot;
  readonly quantity: string;
  /** Price override; differing from the list price needs a reason. */
  readonly unitPriceMinor?: bigint | null;
  readonly priceOverrideReason?: string | null;
  readonly priceOverrideApprovalId?: string | null;
  readonly modifiers?: readonly ModifierInput[];
  readonly checkId?: string | null;
  readonly seatNumber?: number | null;
  readonly courseNumber?: number | null;
  readonly fulfillmentMode?: FulfillmentMode;
  readonly kitchenStatus?: KitchenStatus | null;
  readonly notes?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly parentLineId?: string | null;
}

const KITCHEN_KINDS = new Set(['dine_in', 'takeaway', 'drive_through', 'delivery', 'catering']);
/** Once a kitchen has the line, quantity, price and modifiers are frozen; void and re-add instead. */
const SENT_STATUSES: readonly KitchenStatus[] = ['sent', 'in_progress', 'ready', 'served'];

export function toModifiers(inputs: readonly ModifierInput[], ctx: CommandContext): LineModifier[] {
  return inputs.map((m) => {
    if (!m.name?.trim()) throw ruleInvalid('MODIFIER_NAME_REQUIRED', 'A modifier needs a name');
    const quantity = m.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 32767)
      throw ruleInvalid(
        'MODIFIER_QUANTITY_INVALID',
        'Modifier quantity must be a positive integer',
      );
    return {
      id: ctx.newId(),
      modifierId: m.modifierId ?? null,
      groupName: m.groupName ?? null,
      name: m.name,
      kind: m.kind ?? 'add',
      quantity,
      priceDeltaMinor: m.priceDeltaMinor ?? 0n,
    };
  });
}

function assertSmallInt(value: number | null | undefined, label: string): void {
  if (value == null) return;
  if (!Number.isInteger(value) || value < 1 || value > 32767)
    throw ruleInvalid('NUMBER_INVALID', `${label} must be a positive integer`);
}

/** The check a new line lands on: the named one, else the first open unpaid check, else a new check. */
function targetCheck(
  order: OrderState,
  checkId: string | null | undefined,
  ctx: CommandContext,
): { order: OrderState; check: Check } {
  if (checkId) return { order, check: assertCheckMutable(order, checkId) };
  const open = order.checks
    .filter((c) => c.status === 'open' && c.paidMinor === 0n)
    .sort((a, b) => a.number - b.number)[0];
  if (open) return { order, check: open };
  const number = order.checks.reduce((m, c) => Math.max(m, c.number), 0) + 1;
  const check = emptyCheck(ctx.newId(), number, null);
  return { order: { ...order, checks: [...order.checks, check] }, check };
}

export function addLine(
  order: OrderState,
  input: AddLineInput,
  ctx: CommandContext,
): ReducerResult {
  assertEditable(order);
  if (order.kind === 'return')
    throw ruleConflict('RETURN_ORDER_NO_NEW_LINES', 'A return order only contains returned lines');
  const quantity = parseQuantity(input.quantity);
  if (quantity <= 0n) throw ruleInvalid('QUANTITY_INVALID', 'Quantity must be greater than zero');
  const list = input.snapshot.listPriceMinor;
  if (list < 0n) throw ruleInvalid('LINE_PRICE_NEGATIVE', 'List price must not be negative');
  const unit = input.unitPriceMinor ?? list;
  if (unit < 0n) throw ruleInvalid('LINE_PRICE_NEGATIVE', 'Unit price must not be negative');
  const overridden = unit !== list;
  if (overridden && !input.priceOverrideReason?.trim())
    throw ruleInvalid('PRICE_OVERRIDE_REASON_REQUIRED', 'Changing the price needs a reason');
  assertSmallInt(input.seatNumber, 'seatNumber');
  assertSmallInt(input.courseNumber, 'courseNumber');
  if (input.fulfillmentMode && !FULFILLMENT_MODES.includes(input.fulfillmentMode))
    throw ruleInvalid(
      'FULFILLMENT_MODE_INVALID',
      `Unknown fulfillment mode ${input.fulfillmentMode}`,
    );
  if (input.parentLineId) findLine(order, input.parentLineId);

  const modifiers = toModifiers(input.modifiers ?? [], ctx);
  if (unit + modifiersDelta({ modifiers }) < 0n)
    throw ruleInvalid('LINE_PRICE_NEGATIVE', 'Modifier discounts exceed the unit price');

  const { order: withCheck, check } = targetCheck(order, input.checkId, ctx);
  const seq = order.lines.reduce((m, l) => Math.max(m, l.seq), 0) + 1;
  const line: OrderLine = {
    id: input.id ?? ctx.newId(),
    checkId: check.id,
    seq,
    parentLineId: input.parentLineId ?? null,
    variantId: input.snapshot.variantId,
    itemSnapshot: input.snapshot.itemSnapshot,
    quantity: canonicalQuantity(input.quantity),
    unitOfMeasure: input.snapshot.unitOfMeasure,
    listPriceMinor: list,
    unitPriceMinor: unit,
    priceOverrideReason: overridden ? input.priceOverrideReason!.trim() : null,
    priceOverrideApprovalId: overridden ? (input.priceOverrideApprovalId ?? null) : null,
    modifiers,
    discountMinor: 0n,
    taxMinor: 0n,
    totalMinor: 0n,
    taxes: [],
    seatNumber: input.seatNumber ?? null,
    courseNumber: input.courseNumber ?? null,
    status: 'active',
    voidReason: null,
    voidedBy: null,
    voidApprovalId: null,
    voidedAt: null,
    kitchenStatus:
      input.kitchenStatus !== undefined
        ? input.kitchenStatus
        : KITCHEN_KINDS.has(order.kind)
          ? 'not_sent'
          : null,
    fulfillmentMode: input.fulfillmentMode ?? defaultFulfillmentMode(order.kind),
    returnOfLineId: null,
    returnedQuantity: ZERO_QUANTITY,
    notes: input.notes ?? null,
    grossOverrideMinor: null,
    metadata: input.metadata ?? {},
    createdAt: ctx.now,
  };
  return finish(order, { ...withCheck, lines: [...withCheck.lines, line] }, ctx, [
    {
      kind: 'line_added',
      payload: {
        lineId: line.id,
        seq,
        checkId: check.id,
        variantId: line.variantId,
        name: line.itemSnapshot.name,
        quantity: line.quantity,
        unitPriceMinor: unit.toString(),
        ...(overridden
          ? { listPriceMinor: list.toString(), overrideReason: line.priceOverrideReason }
          : {}),
      },
      approvalId: line.priceOverrideApprovalId,
    },
  ]);
}

export interface UpdateLineInput {
  readonly quantity?: string;
  readonly unitPriceMinor?: bigint;
  readonly priceOverrideReason?: string | null;
  readonly priceOverrideApprovalId?: string | null;
  readonly modifiers?: readonly ModifierInput[];
  readonly seatNumber?: number | null;
  readonly courseNumber?: number | null;
  readonly fulfillmentMode?: FulfillmentMode;
  readonly notes?: string | null;
}

export function updateLine(
  order: OrderState,
  lineId: string,
  patch: UpdateLineInput,
  ctx: CommandContext,
): ReducerResult {
  assertEditable(order);
  const line = findLine(order, lineId);
  if (line.status !== 'active')
    throw ruleConflict('LINE_NOT_ACTIVE', `A ${line.status} line cannot be changed`);
  assertCheckMutable(order, line.checkId);
  const pricing =
    patch.quantity !== undefined ||
    patch.unitPriceMinor !== undefined ||
    patch.modifiers !== undefined;
  if (pricing) {
    if (line.grossOverrideMinor !== null)
      throw ruleConflict(
        'LINE_AMOUNT_FIXED',
        'Shared-item portions and returned lines have a fixed amount; void and re-add instead',
      );
    if (line.kitchenStatus && SENT_STATUSES.includes(line.kitchenStatus))
      throw ruleConflict(
        'LINE_ALREADY_SENT',
        'The kitchen has this line; void it and add a new one',
      );
  }
  let next = line;
  if (patch.quantity !== undefined) {
    if (parseQuantity(patch.quantity) <= 0n)
      throw ruleInvalid('QUANTITY_INVALID', 'Quantity must be greater than zero');
    if (parseQuantity(patch.quantity) < parseQuantity(line.returnedQuantity))
      throw ruleInvalid('QUANTITY_BELOW_RETURNED', 'Quantity cannot drop below what was returned');
    next = { ...next, quantity: canonicalQuantity(patch.quantity) };
  }
  if (patch.unitPriceMinor !== undefined) {
    if (patch.unitPriceMinor < 0n)
      throw ruleInvalid('LINE_PRICE_NEGATIVE', 'Unit price must not be negative');
    const overridden = patch.unitPriceMinor !== line.listPriceMinor;
    const reason = patch.priceOverrideReason ?? line.priceOverrideReason;
    if (overridden && !reason?.trim())
      throw ruleInvalid('PRICE_OVERRIDE_REASON_REQUIRED', 'Changing the price needs a reason');
    next = {
      ...next,
      unitPriceMinor: patch.unitPriceMinor,
      priceOverrideReason: overridden ? reason!.trim() : null,
      priceOverrideApprovalId: overridden
        ? (patch.priceOverrideApprovalId ?? line.priceOverrideApprovalId)
        : null,
    };
  }
  if (patch.modifiers !== undefined)
    next = { ...next, modifiers: toModifiers(patch.modifiers, ctx) };
  if (next.unitPriceMinor + modifiersDelta(next) < 0n)
    throw ruleInvalid('LINE_PRICE_NEGATIVE', 'Modifier discounts exceed the unit price');
  if (patch.seatNumber !== undefined) {
    assertSmallInt(patch.seatNumber, 'seatNumber');
    next = { ...next, seatNumber: patch.seatNumber };
  }
  if (patch.courseNumber !== undefined) {
    assertSmallInt(patch.courseNumber, 'courseNumber');
    next = { ...next, courseNumber: patch.courseNumber };
  }
  if (patch.fulfillmentMode !== undefined) {
    if (!FULFILLMENT_MODES.includes(patch.fulfillmentMode))
      throw ruleInvalid(
        'FULFILLMENT_MODE_INVALID',
        `Unknown fulfillment mode ${patch.fulfillmentMode}`,
      );
    next = { ...next, fulfillmentMode: patch.fulfillmentMode };
  }
  if (patch.notes !== undefined) next = { ...next, notes: patch.notes };
  return finish(order, replaceLine(order, next), ctx, [
    {
      kind: 'line_updated',
      payload: {
        lineId,
        ...(patch.quantity !== undefined
          ? { quantity: next.quantity, previousQuantity: line.quantity }
          : {}),
        ...(patch.unitPriceMinor !== undefined
          ? {
              unitPriceMinor: next.unitPriceMinor.toString(),
              previousUnitPriceMinor: line.unitPriceMinor.toString(),
            }
          : {}),
        ...(patch.modifiers !== undefined ? { modifiers: next.modifiers.length } : {}),
      },
      approvalId: patch.priceOverrideApprovalId ?? null,
    },
  ]);
}

/** Draft only: the line disappears. A placed order keeps the row and uses voidLine (reports need voids). */
export function removeLine(order: OrderState, lineId: string, ctx: CommandContext): ReducerResult {
  if (order.status !== 'draft')
    throw ruleConflict('USE_VOID_LINE', 'Lines of a placed order are voided, not removed', {
      status: order.status,
    });
  const line = findLine(order, lineId);
  assertCheckMutable(order, line.checkId);
  const gone = new Set([
    line.id,
    ...order.lines.filter((l) => l.parentLineId === line.id).map((l) => l.id),
  ]);
  return finish(
    order,
    {
      ...order,
      lines: order.lines.filter((l) => !gone.has(l.id)),
      discounts: order.discounts.filter((d) => d.orderLineId === null || !gone.has(d.orderLineId)),
    },
    ctx,
    [
      {
        kind: 'line_removed',
        payload: { lineId, name: line.itemSnapshot.name, quantity: line.quantity },
      },
    ],
  );
}

export interface VoidLineInput {
  readonly reason: string;
  readonly approvalId?: string | null;
  readonly voidedBy: string | null;
}

/** Placed (open) order: the line stays, marked voided with who, why and which approval allowed it. */
export function voidLine(
  order: OrderState,
  lineId: string,
  input: VoidLineInput,
  ctx: CommandContext,
): ReducerResult {
  if (order.status !== 'open')
    throw ruleConflict(
      'ORDER_NOT_OPEN',
      `Only lines of an open order are voided (order is ${order.status})`,
      {
        status: order.status,
      },
    );
  if (!input.reason?.trim()) throw ruleInvalid('VOID_REASON_REQUIRED', 'A void needs a reason');
  const line = findLine(order, lineId);
  if (line.status !== 'active')
    throw ruleConflict('LINE_NOT_ACTIVE', `The line is already ${line.status}`);
  if (parseQuantity(line.returnedQuantity) > 0n)
    throw ruleConflict('LINE_HAS_RETURNS', 'A line with returns cannot be voided');
  assertCheckMutable(order, line.checkId);
  const children = order.lines.filter((l) => l.parentLineId === line.id && isPriced(l));
  const ids = new Set([line.id, ...children.map((c) => c.id)]);
  const lines = order.lines.map((l) =>
    ids.has(l.id)
      ? {
          ...l,
          status: 'voided' as const,
          voidReason: input.reason.trim(),
          voidedBy: input.voidedBy,
          voidApprovalId: input.approvalId ?? null,
          voidedAt: ctx.now,
          kitchenStatus:
            l.kitchenStatus && l.kitchenStatus !== 'not_sent'
              ? ('cancelled' as const)
              : l.kitchenStatus,
        }
      : l,
  );
  return finish(order, { ...order, lines }, ctx, [
    {
      kind: 'line_voided',
      approvalId: input.approvalId ?? null,
      payload: {
        lineId,
        reason: input.reason.trim(),
        name: line.itemSnapshot.name,
        quantity: line.quantity,
        wasSent: line.kitchenStatus !== null && line.kitchenStatus !== 'not_sent',
        alsoVoided: children.map((c) => c.id),
      },
    },
  ]);
}

export function activeLines(order: OrderState): OrderLine[] {
  return order.lines.filter(isPriced);
}

export function liveLineCount(order: OrderState): number {
  return order.lines.filter((l) => l.status === 'active').length;
}
