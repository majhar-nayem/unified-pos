import {
  type FulfillmentStatus,
  type OrderState,
  type OrderStatus,
  type PaymentStatus,
  FULFILLMENT_STATUSES,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  ruleConflict,
} from './types.js';

/**
 * The three orthogonal status fields and their transition tables
 * (docs/01-system-architecture.md §7.1). A transition not listed here is illegal.
 */

/** Commercial lifecycle. completed → open exists only for `reopenOffline` (offline card declined after forwarding). */
export const ORDER_STATUS_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  draft: ['open', 'cancelled'],
  open: ['suspended', 'completed', 'cancelled'],
  suspended: ['open'],
  completed: ['voided', 'open'],
  cancelled: [],
  voided: [],
};

/** Kitchen / pick / ship progress. `not_applicable` is only ever an initial value. */
export const FULFILLMENT_STATUS_TRANSITIONS: Readonly<
  Record<FulfillmentStatus, readonly FulfillmentStatus[]>
> = {
  unfulfilled: ['in_preparation', 'ready', 'fulfilled'],
  in_preparation: ['partially_ready', 'ready'],
  partially_ready: ['in_preparation', 'ready'],
  ready: ['in_preparation', 'fulfilled'],
  fulfilled: [],
  not_applicable: [],
};

/** Derived from captured payments and refunds. paid/partially_paid → lower states only through a payment reversal. */
export const PAYMENT_STATUS_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> =
  {
    unpaid: ['partially_paid', 'paid'],
    partially_paid: ['unpaid', 'paid'],
    paid: ['partially_paid', 'unpaid', 'partially_refunded', 'refunded'],
    partially_refunded: ['refunded'],
    refunded: [],
    not_applicable: [],
  };

/** Statuses in which the order accepts new or changed lines, discounts and charges. */
export const EDITABLE_STATUSES: readonly OrderStatus[] = ['draft', 'open'];

export function canTransitionStatus(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_STATUS_TRANSITIONS[from].includes(to);
}
export function canTransitionFulfillment(from: FulfillmentStatus, to: FulfillmentStatus): boolean {
  return FULFILLMENT_STATUS_TRANSITIONS[from].includes(to);
}
export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_STATUS_TRANSITIONS[from].includes(to);
}

export function assertStatusTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransitionStatus(from, to))
    throw ruleConflict('ILLEGAL_STATUS_TRANSITION', `Order cannot go from ${from} to ${to}`, {
      from,
      to,
    });
}
export function assertFulfillmentTransition(from: FulfillmentStatus, to: FulfillmentStatus): void {
  if (!canTransitionFulfillment(from, to))
    throw ruleConflict(
      'ILLEGAL_FULFILLMENT_TRANSITION',
      `Fulfillment cannot go from ${from} to ${to}`,
      { from, to },
    );
}
export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (from !== to && !canTransitionPayment(from, to))
    throw ruleConflict(
      'ILLEGAL_PAYMENT_TRANSITION',
      `Payment status cannot go from ${from} to ${to}`,
      {
        from,
        to,
      },
    );
}

export function assertEditable(order: OrderState): void {
  if (!EDITABLE_STATUSES.includes(order.status))
    throw ruleConflict('ORDER_NOT_EDITABLE', `An order that is ${order.status} cannot be changed`, {
      status: order.status,
    });
}

export function isTerminal(status: OrderStatus): boolean {
  return ORDER_STATUS_TRANSITIONS[status].length === 0;
}

/** Every (from, to) pair, for exhaustive tests. */
export function allStatusPairs<T extends string>(values: readonly T[]): Array<[T, T]> {
  return values.flatMap((a) => values.map((b): [T, T] => [a, b]));
}

export const ALL_ORDER_STATUSES = ORDER_STATUSES;
export const ALL_FULFILLMENT_STATUSES = FULFILLMENT_STATUSES;
export const ALL_PAYMENT_STATUSES = PAYMENT_STATUSES;

/**
 * Cross-field rules between the three statuses; reducers call this after every change so no
 * command can leave an impossible combination behind.
 */
export function assertConsistent(order: OrderState): void {
  const fail = (message: string) =>
    ruleConflict('INCONSISTENT_STATUS', message, {
      status: order.status,
      fulfillmentStatus: order.fulfillmentStatus,
      paymentStatus: order.paymentStatus,
    });
  if ((order.status === 'draft' || order.status === 'cancelled') && order.paidMinor !== 0n)
    throw fail(`A ${order.status} order cannot hold payments`);
  if (order.status === 'draft' && order.placedAt !== null)
    throw fail('A draft order has not been placed');
  if (order.status === 'completed' && order.paymentStatus === 'unpaid')
    throw fail('A completed order must be settled');
  if (order.status === 'completed' && order.paymentStatus === 'partially_paid')
    throw fail('A completed order must be settled');
  if (order.orderNumber !== null && order.placedAt === null)
    throw fail('An order number is assigned when the order is placed');
  if (
    (order.status === 'cancelled' || order.status === 'draft') &&
    order.fulfillmentStatus !== 'unfulfilled' &&
    order.fulfillmentStatus !== 'not_applicable'
  )
    throw fail(`A ${order.status} order cannot be in ${order.fulfillmentStatus}`);
}
