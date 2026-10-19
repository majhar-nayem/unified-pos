import { finish } from './aggregate.js';
import type { CommandContext } from './context.js';
import { assertCanAssignNumber } from './order-number.js';
import { assertConsistent, assertFulfillmentTransition, assertStatusTransition } from './status.js';
import {
  type FulfillmentStatus,
  type OrderState,
  type ReducerResult,
  isReturnKind,
  ruleConflict,
  ruleInvalid,
} from './types.js';

export interface UpdateDetailsInput {
  readonly notes?: string | null;
  readonly guestCount?: number | null;
  readonly customerId?: string | null;
  readonly tableSessionId?: string | null;
  readonly employeeId?: string | null;
  readonly scheduledFor?: string | null;
  readonly externalRef?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Notes, guest count, customer attachment and metadata: allowed until the order is finished. */
export function updateDetails(
  order: OrderState,
  patch: UpdateDetailsInput,
  ctx: CommandContext,
): ReducerResult {
  if (!['draft', 'open', 'suspended'].includes(order.status))
    throw ruleConflict('ORDER_NOT_EDITABLE', `An order that is ${order.status} cannot be changed`, {
      status: order.status,
    });
  if (patch.guestCount != null && (!Number.isInteger(patch.guestCount) || patch.guestCount < 0))
    throw ruleInvalid('GUEST_COUNT_INVALID', 'guestCount must be a non-negative integer');
  const next: OrderState = {
    ...order,
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    ...(patch.guestCount !== undefined ? { guestCount: patch.guestCount } : {}),
    ...(patch.customerId !== undefined ? { customerId: patch.customerId } : {}),
    ...(patch.tableSessionId !== undefined ? { tableSessionId: patch.tableSessionId } : {}),
    ...(patch.employeeId !== undefined ? { employeeId: patch.employeeId } : {}),
    ...(patch.scheduledFor !== undefined ? { scheduledFor: patch.scheduledFor } : {}),
    ...(patch.externalRef !== undefined ? { externalRef: patch.externalRef } : {}),
    ...(patch.metadata !== undefined ? { metadata: { ...order.metadata, ...patch.metadata } } : {}),
  };
  const changed = Object.keys(patch).filter(
    (k) => (patch as Record<string, unknown>)[k] !== undefined,
  );
  return finish(order, next, ctx, [
    {
      kind: patch.notes !== undefined && changed.length === 1 ? 'note_added' : 'order_updated',
      payload: { fields: changed },
    },
  ]);
}

export function suspend(
  order: OrderState,
  input: { reason?: string | null },
  ctx: CommandContext,
): ReducerResult {
  assertStatusTransition(order.status, 'suspended');
  if (order.paidMinor !== 0n)
    throw ruleConflict('ORDER_HAS_PAYMENTS', 'An order with payments cannot be suspended');
  const next: OrderState = { ...order, status: 'suspended' };
  assertConsistent(next);
  return finish(order, next, ctx, [
    {
      kind: 'suspended',
      fromStatus: order.status,
      toStatus: 'suspended',
      payload: { reason: input.reason ?? null },
    },
  ]);
}

export function resume(order: OrderState, ctx: CommandContext): ReducerResult {
  assertStatusTransition(order.status, 'open');
  if (order.status !== 'suspended')
    throw ruleConflict('ORDER_NOT_SUSPENDED', 'Only a suspended order can be resumed');
  const next: OrderState = { ...order, status: 'open' };
  return finish(order, next, ctx, [
    { kind: 'resumed', fromStatus: 'suspended', toStatus: 'open', payload: {} },
  ]);
}

export interface PlaceInput {
  /** Canonical per (location, business date), assigned by the server. */
  readonly orderNumber: number;
  /** Re-evaluated at placement for orders created online. */
  readonly businessDate?: string;
}

export function place(order: OrderState, input: PlaceInput, ctx: CommandContext): ReducerResult {
  if (isReturnKind(order.kind))
    throw ruleConflict(
      'RETURN_REQUIRES_SOURCE',
      'Return and exchange orders are placed with placeReturn',
    );
  return placeCommon(order, input, ctx);
}

export function placeCommon(
  order: OrderState,
  input: PlaceInput,
  ctx: CommandContext,
): ReducerResult {
  assertStatusTransition(order.status, 'open');
  if (order.status !== 'draft')
    throw ruleConflict('ORDER_NOT_DRAFT', 'Only a draft order is placed');
  if (!order.lines.some((l) => l.status === 'active'))
    throw ruleConflict('EMPTY_ORDER', 'An order needs at least one line before it is placed');
  assertCanAssignNumber(order, input.orderNumber);
  const next: OrderState = {
    ...order,
    status: 'open',
    orderNumber: input.orderNumber,
    businessDate: input.businessDate ?? order.businessDate,
    placedAt: ctx.now,
  };
  assertConsistent(next);
  const result = finish(order, next, ctx, [
    {
      kind: 'placed',
      fromStatus: 'draft',
      toStatus: 'open',
      payload: { orderNumber: input.orderNumber, businessDate: next.businessDate },
    },
  ]);
  return {
    state: result.state,
    events: result.events.map((e) => ({
      ...e,
      payload: {
        ...e.payload,
        totalMinor: result.state.totalMinor.toString(),
        currency: order.currency,
      },
    })),
  };
}

export interface VoidOrderInput {
  readonly reason: string;
  readonly approvalId?: string | null;
  readonly voidedBy: string | null;
}

/**
 * Draft → cancelled; open → cancelled (nothing paid); completed → voided (authorised). The caller
 * has already checked `orders.void` or consumed an approval; the reducer records who and why.
 */
export function voidOrder(
  order: OrderState,
  input: VoidOrderInput,
  ctx: CommandContext,
): ReducerResult {
  if (!input.reason?.trim()) throw ruleInvalid('VOID_REASON_REQUIRED', 'A void needs a reason');
  if (order.status === 'suspended')
    throw ruleConflict('ORDER_SUSPENDED', 'Resume the order before voiding it');
  if (order.status === 'completed') {
    if (isReturnKind(order.kind))
      throw ruleConflict(
        'RETURN_CANNOT_BE_VOIDED',
        'A completed return or exchange cannot be voided',
      );
    if (order.lines.some((l) => Number(l.returnedQuantity) > 0))
      throw ruleConflict('ORDER_HAS_RETURNS', 'An order with returns cannot be voided');
    assertStatusTransition('completed', 'voided');
    const next: OrderState = {
      ...order,
      status: 'voided',
      voidedAt: ctx.now,
      voidReason: input.reason.trim(),
      voidApprovalId: input.approvalId ?? null,
    };
    return finish(order, next, ctx, [
      {
        kind: 'voided',
        fromStatus: 'completed',
        toStatus: 'voided',
        approvalId: input.approvalId ?? null,
        payload: {
          reason: input.reason.trim(),
          voidedBy: input.voidedBy,
          totalMinor: order.totalMinor.toString(),
          paidMinor: order.paidMinor.toString(),
        },
      },
    ]);
  }
  assertStatusTransition(order.status, 'cancelled');
  if (order.paidMinor !== 0n)
    throw ruleConflict('REFUND_FIRST', 'Refund the payments before cancelling this order', {
      paidMinor: order.paidMinor.toString(),
    });
  const next: OrderState = {
    ...order,
    status: 'cancelled',
    cancelledAt: ctx.now,
    voidReason: input.reason.trim(),
    voidApprovalId: input.approvalId ?? null,
    lines: order.lines.map((l) =>
      l.status === 'active'
        ? {
            ...l,
            status: 'cancelled' as const,
            kitchenStatus:
              l.kitchenStatus && l.kitchenStatus !== 'not_sent'
                ? ('cancelled' as const)
                : l.kitchenStatus,
          }
        : l,
    ),
    checks: order.checks.map((c) =>
      c.status === 'open' ? { ...c, status: 'voided' as const } : c,
    ),
  };
  assertConsistent(next);
  return finish(order, next, ctx, [
    {
      kind: 'cancelled',
      fromStatus: order.status,
      toStatus: 'cancelled',
      approvalId: input.approvalId ?? null,
      payload: {
        reason: input.reason.trim(),
        voidedBy: input.voidedBy,
        wasPlaced: order.placedAt !== null,
      },
    },
  ]);
}

/** Kitchen / pick / ship progress driven by tickets (F7) or the fulfilment flow. */
export function advanceFulfillment(
  order: OrderState,
  to: FulfillmentStatus,
  ctx: CommandContext,
): ReducerResult {
  if (order.status !== 'open' && order.status !== 'completed')
    throw ruleConflict(
      'ORDER_NOT_PLACED',
      `Fulfillment moves on placed orders (order is ${order.status})`,
    );
  assertFulfillmentTransition(order.fulfillmentStatus, to);
  const next: OrderState = { ...order, fulfillmentStatus: to };
  return finish(order, next, ctx, [
    { kind: 'fulfillment_changed', payload: { from: order.fulfillmentStatus, to } },
  ]);
}
