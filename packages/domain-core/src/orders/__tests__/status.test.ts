import { describe, expect, it } from 'vitest';

import {
  ALL_FULFILLMENT_STATUSES,
  ALL_ORDER_STATUSES,
  ALL_PAYMENT_STATUSES,
  allStatusPairs,
  assertConsistent,
  assertFulfillmentTransition,
  assertPaymentTransition,
  assertStatusTransition,
  canTransitionFulfillment,
  canTransitionPayment,
  canTransitionStatus,
  isTerminal,
} from '../status.js';
import {
  type FulfillmentStatus,
  type OrderStatus,
  type PaymentStatus,
  OrderRuleError,
} from '../types.js';
import { draft, makeCtx } from './helpers.js';

// The expected tables are spelled out here, independently of status.ts, so a drive-by edit of the
// implementation table fails these tests (docs/01-system-architecture.md §7.1).
const STATUS_OK = new Set([
  'draft>open',
  'draft>cancelled',
  'open>suspended',
  'open>completed',
  'open>cancelled',
  'suspended>open',
  'completed>voided',
  'completed>open', // reopen after a declined offline card payment
]);
const FULFILLMENT_OK = new Set([
  'unfulfilled>in_preparation',
  'unfulfilled>ready',
  'unfulfilled>fulfilled',
  'in_preparation>partially_ready',
  'in_preparation>ready',
  'partially_ready>in_preparation',
  'partially_ready>ready',
  'ready>in_preparation',
  'ready>fulfilled',
]);
const PAYMENT_OK = new Set([
  'unpaid>partially_paid',
  'unpaid>paid',
  'partially_paid>unpaid',
  'partially_paid>paid',
  'paid>partially_paid',
  'paid>unpaid',
  'paid>partially_refunded',
  'paid>refunded',
  'partially_refunded>refunded',
]);

describe('order status transitions (exhaustive)', () => {
  const pairs = allStatusPairs<OrderStatus>(ALL_ORDER_STATUSES);
  it('covers every pair', () => expect(pairs).toHaveLength(36));
  it.each(pairs)('%s → %s', (from, to) => {
    const allowed = STATUS_OK.has(`${from}>${to}`);
    expect(canTransitionStatus(from, to)).toBe(allowed);
    if (allowed) expect(() => assertStatusTransition(from, to)).not.toThrow();
    else expect(() => assertStatusTransition(from, to)).toThrow(OrderRuleError);
  });
  it('cancelled and voided are terminal; nothing else is', () => {
    expect(ALL_ORDER_STATUSES.filter(isTerminal)).toEqual(['cancelled', 'voided']);
  });
});

describe('fulfillment status transitions (exhaustive)', () => {
  const pairs = allStatusPairs<FulfillmentStatus>(ALL_FULFILLMENT_STATUSES);
  it('covers every pair', () => expect(pairs).toHaveLength(36));
  it.each(pairs)('%s → %s', (from, to) => {
    const allowed = FULFILLMENT_OK.has(`${from}>${to}`);
    expect(canTransitionFulfillment(from, to)).toBe(allowed);
    if (allowed) expect(() => assertFulfillmentTransition(from, to)).not.toThrow();
    else expect(() => assertFulfillmentTransition(from, to)).toThrow(OrderRuleError);
  });
  it('not_applicable is never a target', () => {
    for (const from of ALL_FULFILLMENT_STATUSES)
      expect(canTransitionFulfillment(from, 'not_applicable')).toBe(false);
  });
});

describe('payment status transitions (exhaustive)', () => {
  const pairs = allStatusPairs<PaymentStatus>(ALL_PAYMENT_STATUSES);
  it('covers every pair', () => expect(pairs).toHaveLength(36));
  it.each(pairs)('%s → %s', (from, to) => {
    const allowed = PAYMENT_OK.has(`${from}>${to}`);
    expect(canTransitionPayment(from, to)).toBe(allowed);
    // staying put is always fine for the assertion (a repeated derivation changes nothing)
    if (allowed || from === to) expect(() => assertPaymentTransition(from, to)).not.toThrow();
    else expect(() => assertPaymentTransition(from, to)).toThrow(OrderRuleError);
  });
});

describe('cross-status consistency', () => {
  const base = draft(makeCtx());
  const broken = (patch: Record<string, unknown>) => ({ ...base, ...patch }) as typeof base;
  it('accepts a fresh draft', () => expect(() => assertConsistent(base)).not.toThrow());
  it('rejects impossible combinations', () => {
    expect(() => assertConsistent(broken({ status: 'draft', paidMinor: 100n }))).toThrow(
      /cannot hold payments/,
    );
    expect(() => assertConsistent(broken({ status: 'cancelled', paidMinor: 100n }))).toThrow(
      /cannot hold payments/,
    );
    expect(() => assertConsistent(broken({ status: 'draft', placedAt: 'x' }))).toThrow(
      /not been placed/,
    );
    expect(() =>
      assertConsistent(
        broken({ status: 'completed', paymentStatus: 'unpaid', placedAt: 'x', orderNumber: 1 }),
      ),
    ).toThrow(/settled/);
    expect(() =>
      assertConsistent(
        broken({
          status: 'completed',
          paymentStatus: 'partially_paid',
          placedAt: 'x',
          orderNumber: 1,
        }),
      ),
    ).toThrow(/settled/);
    expect(() => assertConsistent(broken({ orderNumber: 3, placedAt: null }))).toThrow(
      /order number/,
    );
    expect(() =>
      assertConsistent(broken({ status: 'cancelled', fulfillmentStatus: 'ready' })),
    ).toThrow(/cannot be in ready/);
  });
  it('accepts completed + paid and completed + refunded', () => {
    for (const paymentStatus of [
      'paid',
      'refunded',
      'partially_refunded',
      'not_applicable',
    ] as const)
      expect(() =>
        assertConsistent(
          broken({ status: 'completed', paymentStatus, placedAt: 'x', orderNumber: 1 }),
        ),
      ).not.toThrow();
  });
});
