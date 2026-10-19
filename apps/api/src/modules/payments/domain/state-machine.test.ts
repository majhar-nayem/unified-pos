import { PAYMENT_INTENT_STATUSES, type PaymentIntentStatus } from '@pos/contracts';
import { describe, expect, it } from 'vitest';

import {
  CAPTURED_STATUSES,
  InvalidTransitionError,
  TERMINAL_STATUSES,
  TRANSITIONS,
  assertTransition,
  canTransition,
  isPaid,
  isTerminal,
  netCollected,
  statusAfterRefund,
} from './state-machine.js';

/** docs/01-system-architecture.md §7.3, edge by edge, plus the two documented extensions. */
const ALLOWED: readonly [PaymentIntentStatus, PaymentIntentStatus][] = [
  ['created', 'processing'],
  ['created', 'cancelled'],
  ['processing', 'authorized'],
  ['processing', 'captured'],
  ['processing', 'failed'],
  ['processing', 'uncertain'],
  ['uncertain', 'captured'],
  ['uncertain', 'failed'],
  ['uncertain', 'uncertain'],
  ['uncertain', 'authorized'], // extension: a pre-auth confirmed by the provider query
  ['authorized', 'captured'],
  ['authorized', 'cancelled'],
  ['captured', 'reversed'],
  ['captured', 'partially_refunded'],
  ['captured', 'refunded'],
  ['partially_refunded', 'refunded'],
];

describe('payment state machine: exhaustive transitions', () => {
  const key = (a: string, b: string) => `${a}>${b}`;
  const allowed = new Set(ALLOWED.map(([a, b]) => key(a, b)));

  it('covers all 10 states', () => {
    expect([...PAYMENT_INTENT_STATUSES].sort()).toEqual(
      [
        'authorized',
        'cancelled',
        'captured',
        'created',
        'failed',
        'partially_refunded',
        'processing',
        'refunded',
        'reversed',
        'uncertain',
      ].sort(),
    );
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...PAYMENT_INTENT_STATUSES].sort());
  });

  for (const from of PAYMENT_INTENT_STATUSES) {
    for (const to of PAYMENT_INTENT_STATUSES) {
      const ok = allowed.has(key(from, to));
      it(`${from} → ${to} is ${ok ? 'allowed' : 'refused'}`, () => {
        expect(canTransition(from, to)).toBe(ok);
        if (ok) expect(() => assertTransition(from, to)).not.toThrow();
        else expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
      });
    }
  }

  it('the table lists exactly the allowed edges (no hidden extras)', () => {
    const fromTable = new Set(
      Object.entries(TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => key(from, to))),
    );
    expect(fromTable).toEqual(allowed);
  });

  it('terminal states have no way out, even with the offline guard', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(isTerminal(status)).toBe(true);
      for (const to of PAYMENT_INTENT_STATUSES)
        expect(canTransition(status, to, { offlineForwardFailed: true })).toBe(false);
    }
    for (const status of PAYMENT_INTENT_STATUSES.filter((s) => !TERMINAL_STATUSES.includes(s)))
      expect(isTerminal(status)).toBe(false);
  });

  it('captured → failed exists only behind the offline forward guard', () => {
    expect(canTransition('captured', 'failed')).toBe(false);
    expect(canTransition('captured', 'failed', {})).toBe(false);
    expect(canTransition('captured', 'failed', { offlineForwardFailed: false })).toBe(false);
    expect(canTransition('captured', 'failed', { offlineForwardFailed: true })).toBe(true);
    // the guard unlocks nothing else
    for (const from of PAYMENT_INTENT_STATUSES) {
      for (const to of PAYMENT_INTENT_STATUSES) {
        if (from === 'captured' && to === 'failed') continue;
        expect(canTransition(from, to, { offlineForwardFailed: true })).toBe(
          canTransition(from, to),
        );
      }
    }
  });

  it('only a captured payment can ever be refunded or reversed', () => {
    for (const status of PAYMENT_INTENT_STATUSES) {
      const canRefund =
        canTransition(status, 'partially_refunded') || canTransition(status, 'refunded');
      expect(canRefund).toBe(
        status === 'captured' ||
          (status === 'partially_refunded' && canTransition(status, 'refunded')),
      );
      expect(canTransition(status, 'reversed')).toBe(status === 'captured');
    }
  });

  it('an unknown outcome can never become `declined` without certainty: failed is reachable from uncertain only via a provider answer', () => {
    // the machine itself allows it; the services only take it after getStatus / a replay says so
    expect(canTransition('uncertain', 'failed')).toBe(true);
    expect(canTransition('created', 'failed')).toBe(false);
  });
});

describe('refund status arithmetic', () => {
  it('partially refunded until the full captured amount is back', () => {
    expect(statusAfterRefund('captured', 1000n, 400n)).toBe('partially_refunded');
    expect(statusAfterRefund('partially_refunded', 1000n, 999n)).toBe('partially_refunded');
    expect(statusAfterRefund('partially_refunded', 1000n, 1000n)).toBe('refunded');
    expect(statusAfterRefund('captured', 1000n, 1000n)).toBe('refunded');
  });

  it('only captured states can be refunded', () => {
    for (const status of PAYMENT_INTENT_STATUSES.filter(
      (s) => !['captured', 'partially_refunded'].includes(s),
    ))
      expect(() => statusAfterRefund(status, 1000n, 100n)).toThrow(InvalidTransitionError);
  });
});

describe('paid only when captured (docs/01 §7.3 invariant)', () => {
  it('nets captured minus refunded across intents and compares with the check total', () => {
    expect(netCollected([])).toBe(0n);
    expect(isPaid([], 1000n)).toBe(false);
    expect(isPaid([{ capturedMinor: 600n, refundedMinor: 0n }], 1000n)).toBe(false);
    expect(
      isPaid(
        [
          { capturedMinor: 600n, refundedMinor: 0n },
          { capturedMinor: 400n, refundedMinor: 0n },
        ],
        1000n,
      ),
    ).toBe(true);
    expect(isPaid([{ capturedMinor: 1000n, refundedMinor: 1n }], 1000n)).toBe(false);
    expect(isPaid([{ capturedMinor: 0n, refundedMinor: 0n }], 0n)).toBe(false); // nothing to pay is not "paid by money"
  });

  it('authorized, processing and uncertain intents hold no captured money', () => {
    for (const status of PAYMENT_INTENT_STATUSES)
      expect(CAPTURED_STATUSES.includes(status)).toBe(
        ['captured', 'partially_refunded', 'refunded'].includes(status),
      );
  });
});
