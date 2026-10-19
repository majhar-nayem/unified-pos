import { businessDate as businessDateOf } from '../time/business-date.js';
import { type OrderState, ruleConflict, ruleInvalid } from './types.js';

/**
 * Order numbering rules (docs/02-database-design.md §3.6).
 *
 * - `orderNumber` is canonical: a positive integer per (location, business date), assigned by the
 *   server when the order is placed, never by a device and never before placement.
 * - `clientOrderRef` is the register-local number an offline device prints ("R1-000123"). It is
 *   unique per location, kept for reconciliation, and never replaces the canonical number.
 * - The business date follows the location's time zone and day boundary. An order created offline
 *   keeps the business date of the device clock (`clientCreatedAt`), otherwise the server's clock
 *   at creation, re-evaluated when the order is placed.
 */

export const CLIENT_ORDER_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function assertClientOrderRef(ref: string): void {
  if (!CLIENT_ORDER_REF.test(ref))
    throw ruleInvalid(
      'CLIENT_ORDER_REF_INVALID',
      'clientOrderRef must be 1-64 URL-safe characters',
      {
        ref,
      },
    );
}

export interface BusinessDateInput {
  readonly now: Date;
  /** Device clock at creation for offline orders. */
  readonly clientCreatedAt?: Date | null;
  readonly timezone: string;
  /** 'HH:MM' local time the trading day starts. */
  readonly boundary: string;
}

export function resolveBusinessDate(input: BusinessDateInput): string {
  return businessDateOf(input.clientCreatedAt ?? input.now, input.timezone, input.boundary);
}

/** A device that never reaches the server can only print its own reference. */
export function displayOrderNumber(
  order: Pick<OrderState, 'orderNumber' | 'clientOrderRef'>,
): string {
  if (order.orderNumber !== null) return String(order.orderNumber).padStart(4, '0');
  return order.clientOrderRef ?? '—';
}

/** Receipt number: business date plus canonical number, "20261018-0042". */
export function receiptBaseNumber(
  order: Pick<OrderState, 'businessDate' | 'orderNumber' | 'clientOrderRef'>,
): string {
  return `${order.businessDate.replaceAll('-', '')}-${displayOrderNumber(order)}`;
}

export function assertCanAssignNumber(order: OrderState, orderNumber: number): void {
  if (!Number.isInteger(orderNumber) || orderNumber <= 0)
    throw ruleInvalid('ORDER_NUMBER_INVALID', 'orderNumber must be a positive integer');
  if (order.orderNumber !== null)
    throw ruleConflict(
      'ORDER_NUMBER_ALREADY_ASSIGNED',
      'The order already has a canonical number',
      {
        orderNumber: order.orderNumber,
      },
    );
  if (order.status !== 'draft')
    throw ruleConflict(
      'ORDER_NUMBER_ONLY_ON_PLACE',
      'Order numbers are assigned when a draft is placed',
    );
}

/** SQL the order-number sequence uses, exported so the rule and the statement stay together. */
export const NEXT_ORDER_NUMBER_SQL = `
  INSERT INTO orders.order_number_sequences (tenant_id, location_id, business_date, next_value)
  VALUES ($1, $2, $3, 2)
  ON CONFLICT (location_id, business_date)
  DO UPDATE SET next_value = orders.order_number_sequences.next_value + 1
  RETURNING next_value - 1 AS order_number`;
