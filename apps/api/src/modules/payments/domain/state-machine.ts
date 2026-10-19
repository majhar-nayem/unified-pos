import type { PaymentIntentStatus } from '@pos/contracts';

/**
 * Payment intent state machine (docs/01-system-architecture.md §7.3).
 *
 *   created → processing | cancelled
 *   processing → authorized | captured | failed | uncertain
 *   uncertain → authorized | captured | failed | uncertain
 *   authorized → captured | cancelled
 *   captured → reversed | partially_refunded | refunded
 *   partially_refunded → refunded
 *
 * Two documented extensions to the diagram:
 *  - `uncertain → authorized`: a pre-auth (manual capture) whose provider query says "authorized".
 *  - `captured → failed`, ONLY for an offline-collected payment whose forward was declined or
 *    expired (docs/01 §8.3): the store-and-forward sale was recorded as captured, the issuer then
 *    refused it, so the money never arrives. It needs the `offline_forward_failed` guard.
 * A refund that leaves the intent partially refunded is an event, not a transition.
 */
export const TRANSITIONS: Readonly<Record<PaymentIntentStatus, readonly PaymentIntentStatus[]>> = {
  created: ['processing', 'cancelled'],
  processing: ['authorized', 'captured', 'failed', 'uncertain'],
  uncertain: ['authorized', 'captured', 'failed', 'uncertain'],
  authorized: ['captured', 'cancelled'],
  captured: ['reversed', 'partially_refunded', 'refunded'],
  partially_refunded: ['refunded'],
  failed: [],
  cancelled: [],
  reversed: [],
  refunded: [],
};

export const TERMINAL_STATUSES: readonly PaymentIntentStatus[] = [
  'failed',
  'cancelled',
  'reversed',
  'refunded',
];

/** States that hold or will hold customer money against the check. */
export const CAPTURED_STATUSES: readonly PaymentIntentStatus[] = [
  'captured',
  'partially_refunded',
  'refunded',
];

export interface TransitionContext {
  /** Guard for `captured → failed`: the intent is offline and its forward outcome is declined or expired. */
  readonly offlineForwardFailed?: boolean;
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: PaymentIntentStatus,
    public readonly to: PaymentIntentStatus,
  ) {
    super(`Payment intent cannot move from ${from} to ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(
  from: PaymentIntentStatus,
  to: PaymentIntentStatus,
  context: TransitionContext = {},
): boolean {
  if (TRANSITIONS[from].includes(to)) return true;
  return from === 'captured' && to === 'failed' && context.offlineForwardFailed === true;
}

export function assertTransition(
  from: PaymentIntentStatus,
  to: PaymentIntentStatus,
  context: TransitionContext = {},
): void {
  if (!canTransition(from, to, context)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(status: PaymentIntentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Status after a refund brings `refundedMinor` of `capturedMinor` back, or the current status when
 * it stays partially refunded.
 */
export function statusAfterRefund(
  current: PaymentIntentStatus,
  capturedMinor: bigint,
  refundedMinor: bigint,
): PaymentIntentStatus {
  if (current !== 'captured' && current !== 'partially_refunded')
    throw new InvalidTransitionError(current, 'partially_refunded');
  if (refundedMinor <= 0n) return current;
  return refundedMinor >= capturedMinor ? 'refunded' : 'partially_refunded';
}

/**
 * docs/01 §7.3 invariant: money collected against a check is the sum of
 * `captured_minor − refunded_minor` over its intents; the order is `paid` only when that reaches
 * the check total, never on "request sent".
 */
export function netCollected(
  intents: readonly { capturedMinor: bigint; refundedMinor: bigint }[],
): bigint {
  return intents.reduce((sum, i) => sum + i.capturedMinor - i.refundedMinor, 0n);
}

export function isPaid(
  intents: readonly { capturedMinor: bigint; refundedMinor: bigint }[],
  totalMinor: bigint,
): boolean {
  return totalMinor > 0n && netCollected(intents) >= totalMinor;
}
