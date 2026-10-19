import { findCheck, finish, replaceCheck, sumChecks } from './aggregate.js';
import type { CommandContext } from './context.js';
import {
  assertConsistent,
  assertFulfillmentTransition,
  assertPaymentTransition,
  assertStatusTransition,
  canTransitionFulfillment,
} from './status.js';
import {
  type Check,
  type OrderState,
  type PaymentStatus,
  type ReducerResult,
  type ReopenReason,
  ruleConflict,
  ruleInvalid,
} from './types.js';

const abs = (n: bigint) => (n < 0n ? -n : n);

/**
 * payment_status is derived from captured money: refunds first, then paid against total.
 * Magnitudes are compared so return orders (negative totals, negative payments) behave the same.
 * A zero-total order stays unpaid until it is explicitly settled (`settledZero`).
 */
export function derivePaymentStatus(
  order: Pick<OrderState, 'totalMinor' | 'paidMinor' | 'refundedMinor'>,
  settledZero = false,
): PaymentStatus {
  const total = abs(order.totalMinor);
  const paid = abs(order.paidMinor);
  if (order.refundedMinor > 0n)
    return order.refundedMinor >= paid ? 'refunded' : 'partially_refunded';
  if (paid === 0n) return total === 0n && settledZero ? 'paid' : 'unpaid';
  return paid >= total ? 'paid' : 'partially_paid';
}

function pickCheck(
  order: OrderState,
  checkId: string | undefined,
  usable: (c: Check) => boolean,
  none: { code: string; message: string },
): Check {
  if (checkId) return findCheck(order, checkId);
  const candidates = order.checks.filter((c) => c.status !== 'voided' && usable(c));
  if (candidates.length === 0) throw ruleConflict(none.code, none.message);
  if (candidates.length !== 1)
    throw ruleInvalid('CHECK_REQUIRED', 'Name the check: the order has more than one candidate', {
      candidates: candidates.map((c) => c.id),
    });
  return candidates[0]!;
}

export interface ApplyPaymentCommand {
  readonly checkId?: string;
  readonly amountMinor: bigint;
  readonly tipMinor?: bigint;
  readonly roundingMinor?: bigint;
  readonly paymentRef: string;
  readonly method?: string;
}

/** Record captured money against a check; closes the check when it is exactly settled. */
export function applyPayment(
  order: OrderState,
  cmd: ApplyPaymentCommand,
  ctx: CommandContext,
): ReducerResult {
  if (order.status !== 'open')
    throw ruleConflict(
      'ORDER_NOT_OPEN',
      `Payments apply to an open order (order is ${order.status})`,
      {
        status: order.status,
      },
    );
  if (!cmd.paymentRef) throw ruleInvalid('PAYMENT_REF_REQUIRED', 'paymentRef is required');
  const check = pickCheck(order, cmd.checkId, (c) => c.status === 'open', {
    code: 'NOTHING_DUE',
    message: 'Every check of this order is already settled',
  });
  if (check.status !== 'open')
    throw ruleConflict('CHECK_NOT_OPEN', `Check ${check.number} is ${check.status}`, {
      checkId: check.id,
    });
  if (cmd.amountMinor === 0n)
    throw ruleInvalid('PAYMENT_AMOUNT_INVALID', 'Payment amount must not be zero');
  const tip = cmd.tipMinor ?? 0n;
  if (tip < 0n) throw ruleInvalid('TIP_INVALID', 'Tip must not be negative');

  const withExtras = replaceCheck(order, {
    ...check,
    tipMinor: check.tipMinor + tip,
    roundingMinor: cmd.roundingMinor ?? check.roundingMinor,
  });
  // Totals include tip and rounding, so reprice before judging the amount.
  const repriced = finish(order, withExtras, ctx, []).state;
  const updated = findCheck(repriced, check.id);
  const sign = updated.totalMinor < 0n ? -1n : 1n;
  if (updated.totalMinor === 0n)
    throw ruleConflict(
      'CHECK_HAS_NOTHING_DUE',
      'The check has nothing to pay; settle it with markPaid',
    );
  if (cmd.amountMinor * sign < 0n)
    throw ruleInvalid(
      'PAYMENT_AMOUNT_INVALID',
      'Payment amount must have the same sign as the check total',
    );
  const newPaid = updated.paidMinor + cmd.amountMinor;
  if (abs(newPaid) > abs(updated.totalMinor))
    throw ruleConflict('OVERPAYMENT', 'The payment exceeds the amount due', {
      dueMinor: (updated.totalMinor - updated.paidMinor).toString(),
      amountMinor: cmd.amountMinor.toString(),
    });
  const settled = newPaid === updated.totalMinor;
  const paidCheck: Check = {
    ...updated,
    paidMinor: newPaid,
    ...(settled ? { status: 'closed' as const, closedAt: ctx.now, closedBy: ctx.actorId } : {}),
  };
  let next = replaceCheck(repriced, paidCheck);
  const sums = sumChecks(next.checks);
  next = { ...next, ...sums };
  const status = derivePaymentStatus(next);
  assertPaymentTransition(order.paymentStatus, status);
  next = { ...next, paymentStatus: status };
  assertConsistent(next);
  return {
    state: {
      ...next,
      version: order.version + 1,
      updatedAt: ctx.now,
      checks: bumpChecks(order, next),
    },
    events: [
      {
        kind: 'payment_applied',
        payload: {
          checkId: check.id,
          amountMinor: cmd.amountMinor.toString(),
          tipMinor: tip.toString(),
          roundingMinor: (cmd.roundingMinor ?? check.roundingMinor).toString(),
          paymentRef: cmd.paymentRef,
          method: cmd.method ?? null,
          paidMinor: newPaid.toString(),
          dueMinor: (updated.totalMinor - newPaid).toString(),
          checkClosed: settled,
        },
      },
    ],
  };
}

function bumpChecks(before: OrderState, after: OrderState): Check[] {
  return after.checks.map((c) => {
    const old = before.checks.find((o) => o.id === c.id);
    if (!old) return c;
    const same =
      old.paidMinor === c.paidMinor &&
      old.totalMinor === c.totalMinor &&
      old.status === c.status &&
      old.tipMinor === c.tipMinor &&
      old.roundingMinor === c.roundingMinor &&
      old.refundedMinor === c.refundedMinor;
    return same ? c : { ...c, version: old.version + 1 };
  });
}

/** Complete the order once every check is settled (paid exactly, or nothing due). */
export function markPaid(order: OrderState, ctx: CommandContext): ReducerResult {
  assertStatusTransition(order.status, 'completed');
  if (order.status !== 'open')
    throw ruleConflict(
      'ORDER_NOT_OPEN',
      `Only an open order is completed (order is ${order.status})`,
    );
  if (!order.lines.some((l) => l.status === 'active' || l.status === 'returned'))
    throw ruleConflict('EMPTY_ORDER', 'An order without lines cannot be completed');
  const unsettled = order.checks.filter(
    (c) => c.status !== 'voided' && c.paidMinor !== c.totalMinor,
  );
  if (unsettled.length > 0)
    throw ruleConflict(
      'ORDER_NOT_FULLY_PAID',
      'Every check must be settled before the order completes',
      {
        checks: unsettled.map((c) => ({
          checkId: c.id,
          dueMinor: (c.totalMinor - c.paidMinor).toString(),
        })),
      },
    );
  const checks = order.checks.map((c) =>
    c.status === 'open'
      ? { ...c, status: 'closed' as const, closedAt: ctx.now, closedBy: ctx.actorId }
      : c,
  );
  const settledZero = order.totalMinor === 0n;
  let next: OrderState = {
    ...order,
    checks,
    status: 'completed',
    completedAt: ctx.now,
    reopenedAt: order.reopenedAt,
  };
  const payment = derivePaymentStatus(next, settledZero);
  assertPaymentTransition(order.paymentStatus, payment);
  next = { ...next, paymentStatus: payment };
  if (
    order.kind === 'retail_sale' &&
    order.fulfillmentStatus === 'unfulfilled' &&
    canTransitionFulfillment('unfulfilled', 'fulfilled')
  ) {
    assertFulfillmentTransition('unfulfilled', 'fulfilled');
    next = { ...next, fulfillmentStatus: 'fulfilled' };
  }
  assertConsistent(next);
  return {
    state: {
      ...next,
      version: order.version + 1,
      updatedAt: ctx.now,
      checks: bumpChecks(order, next),
    },
    events: [
      {
        kind: 'completed',
        fromStatus: 'open',
        toStatus: 'completed',
        payload: {
          totalMinor: order.totalMinor.toString(),
          paidMinor: order.paidMinor.toString(),
          paymentStatus: payment,
        },
      },
    ],
  };
}

export interface ApplyRefundCommand {
  readonly checkId?: string;
  readonly amountMinor: bigint;
  readonly paymentRef: string;
  readonly reason?: string;
}

/** Money handed back against a completed sale: partially_refunded, then refunded. */
export function applyRefund(
  order: OrderState,
  cmd: ApplyRefundCommand,
  ctx: CommandContext,
): ReducerResult {
  if (order.status !== 'completed')
    throw ruleConflict(
      'ORDER_NOT_COMPLETED',
      `Refunds apply to a completed order (order is ${order.status})`,
    );
  if (order.totalMinor < 0n)
    throw ruleConflict(
      'REFUND_ON_RETURN',
      'A return order is itself the refund; refund its source order',
    );
  if (cmd.amountMinor <= 0n)
    throw ruleInvalid('REFUND_AMOUNT_INVALID', 'Refund amount must be positive');
  const check = pickCheck(order, cmd.checkId, (c) => c.paidMinor > c.refundedMinor, {
    code: 'NOTHING_TO_REFUND',
    message: 'Everything this order took has already been refunded',
  });
  if (check.refundedMinor + cmd.amountMinor > check.paidMinor)
    throw ruleConflict('REFUND_EXCEEDS_PAID', 'The refund exceeds what the check paid', {
      refundableMinor: (check.paidMinor - check.refundedMinor).toString(),
    });
  const updated = { ...check, refundedMinor: check.refundedMinor + cmd.amountMinor };
  let next = replaceCheck(order, updated);
  next = { ...next, ...sumChecks(next.checks) };
  const status = derivePaymentStatus(next);
  assertPaymentTransition(order.paymentStatus, status);
  next = { ...next, paymentStatus: status };
  return {
    state: {
      ...next,
      version: order.version + 1,
      updatedAt: ctx.now,
      checks: bumpChecks(order, next),
    },
    events: [
      {
        kind: 'refund_applied',
        payload: {
          checkId: check.id,
          amountMinor: cmd.amountMinor.toString(),
          paymentRef: cmd.paymentRef,
          reason: cmd.reason ?? null,
          refundedMinor: updated.refundedMinor.toString(),
          paymentStatus: status,
        },
      },
    ],
  };
}

export interface ReopenOfflineCommand {
  readonly checkId?: string;
  readonly reversedMinor: bigint;
  readonly reason: ReopenReason;
  readonly paymentRef?: string;
}

/** completed → open after an offline card payment was declined once forwarded; the declined money leaves the check. */
export function reopenOffline(
  order: OrderState,
  cmd: ReopenOfflineCommand,
  ctx: CommandContext,
): ReducerResult {
  assertStatusTransition(order.status, 'open');
  if (order.status !== 'completed')
    throw ruleConflict('ORDER_NOT_COMPLETED', 'Only a completed order is reopened');
  if (order.refundedMinor !== 0n)
    throw ruleConflict('ORDER_HAS_REFUNDS', 'An order with refunds cannot be reopened');
  const check = pickCheck(order, cmd.checkId, (c) => c.paidMinor !== 0n, {
    code: 'NOTHING_TO_REVERSE',
    message: 'No check of this order holds a payment to reverse',
  });
  if (cmd.reversedMinor <= 0n || abs(cmd.reversedMinor) > abs(check.paidMinor))
    throw ruleInvalid(
      'REVERSAL_INVALID',
      'The reversed amount must be positive and at most what the check paid',
    );
  const sign = check.paidMinor < 0n ? -1n : 1n;
  const reopened: Check = {
    ...check,
    paidMinor: check.paidMinor - cmd.reversedMinor * sign,
    status: 'open',
    closedAt: null,
    closedBy: null,
  };
  let next = replaceCheck(order, reopened);
  next = {
    ...next,
    ...sumChecks(next.checks),
    status: 'open',
    completedAt: null,
    reopenedAt: ctx.now,
    reopenedReason: cmd.reason,
  };
  const status = derivePaymentStatus(next);
  assertPaymentTransition(order.paymentStatus, status);
  next = { ...next, paymentStatus: status };
  assertConsistent(next);
  return {
    state: {
      ...next,
      version: order.version + 1,
      updatedAt: ctx.now,
      checks: bumpChecks(order, next),
    },
    events: [
      {
        kind: 'reopened_offline_decline',
        fromStatus: 'completed',
        toStatus: 'open',
        payload: {
          reason: cmd.reason,
          checkId: check.id,
          reversedMinor: cmd.reversedMinor.toString(),
          paymentRef: cmd.paymentRef ?? null,
          paymentStatus: status,
        },
      },
    ],
  };
}
