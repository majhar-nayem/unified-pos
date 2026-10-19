import { randomUUID } from 'node:crypto';

import type { Money } from '@pos/domain-core';

import {
  type Capabilities,
  type IdempotencyKey,
  type InvalidSignature,
  type PaymentProviderAdapter,
  type PaymentRequest,
  type ProviderAccount,
  type ProviderRef,
  type ProviderResult,
  type ProviderStatus,
  ProviderTimeoutError,
  type SettlementBatch,
  type SettlementLine,
  type SettlementPeriod,
  type WebhookEvent,
  type WebhookEventType,
  type WebhookHeaders,
} from './adapter.js';
import { redactForStorage } from './redaction.js';
import { headerValue, signWebhookPayload, verifyWebhookSignature } from './webhook-signature.js';

interface MockPayment {
  state: 'authorized' | 'captured' | 'refunded' | 'reversed' | 'declined';
  amount: Money;
  refunded: bigint;
  capturedAt: Date | null;
  refunds: { id: string; amount: bigint; at: Date }[];
  metadata: Readonly<Record<string, string>>;
  reference: string;
}

/**
 * Scripted outcomes. `approve` and `decline` are certain. `timeout` throws ProviderTimeoutError
 * without recording anything (the provider never saw the request). `uncertain_then_approved`
 * records the payment on the provider side but answers `uncertain`, so only `getStatus` reveals
 * the approval (the "timeout after submit" case of docs/01 §7.3). `uncertain_then_declined` likewise.
 * `timeout_after_submit` is the nastiest case: the provider completes and remembers the operation
 * (so a replay under the same idempotency key returns the original result) but the caller sees a
 * timeout exception and never learns the provider reference.
 */
export type MockOutcome =
  | 'approve'
  | 'timeout_after_submit'
  | 'decline'
  | 'timeout'
  | 'uncertain_then_approved'
  | 'uncertain_then_declined';

export type MockOperation = 'createPayment' | 'capture' | 'refund' | 'reverse';

export interface MockProviderOptions {
  readonly webhookSecret?: string;
  readonly clock?: () => Date;
  /** Fee charged per capture line in settlement files, in minor units (default 30 + 1.75 %). */
  readonly feeFor?: (amountMinor: bigint) => bigint;
}

export const MOCK_WEBHOOK_HEADER = 'x-mock-signature';
export const MOCK_DEFAULT_WEBHOOK_SECRET = 'whsec_mock_test_secret';

export interface SignedWebhook {
  readonly headers: Record<string, string>;
  readonly rawBody: string;
  readonly externalEventId: string;
}

/**
 * Deterministic in-memory provider for end-to-end tests without a bank.
 * Behaviour hooks, in order of precedence: a scripted outcome queued with `script()`, then the
 * amount convention (minor units ending in 99 → declined, 98 → uncertain-then-approved).
 * Every call is idempotent on its idempotency key (a replay never charges twice).
 */
export class MockPaymentProvider implements PaymentProviderAdapter {
  readonly key = 'mock' as const;
  readonly simulated = true;
  private readonly payments = new Map<string, MockPayment>();
  private readonly idempotent = new Map<IdempotencyKey, ProviderResult>();
  private readonly scripts = new Map<MockOperation, MockOutcome[]>();
  private readonly calls: { operation: MockOperation; idem: IdempotencyKey }[] = [];
  private readonly settlementOverrides = new Map<
    string,
    { amountMinor?: bigint; drop?: boolean }
  >();
  private readonly extraSettlementLines: SettlementLine[] = [];
  private sequence = 0;
  private eventSequence = 0;
  private throwAfterRecording = false;
  private statusQueries = 0;
  private readonly webhookSecret: string;
  private readonly clock: () => Date;
  private readonly feeFor: (amountMinor: bigint) => bigint;

  constructor(options: MockProviderOptions = {}) {
    this.webhookSecret = options.webhookSecret ?? MOCK_DEFAULT_WEBHOOK_SECRET;
    this.clock = options.clock ?? (() => new Date());
    this.feeFor = options.feeFor ?? ((amount) => 30n + (amount * 175n) / 10_000n);
  }

  // --- scripting -----------------------------------------------------------

  /** Queue outcomes for the next calls of `operation` (consumed in order; the amount rule applies after). */
  script(operation: MockOperation, ...outcomes: MockOutcome[]): this {
    this.scripts.set(operation, [...(this.scripts.get(operation) ?? []), ...outcomes]);
    return this;
  }

  /** Every provider call so far (idempotent replays included), for "no duplicate charge" assertions. */
  get callLog(): readonly { operation: MockOperation; idem: IdempotencyKey }[] {
    return this.calls;
  }

  /** Number of distinct charges recorded on the provider side (what the merchant would be paid for). */
  get chargeCount(): number {
    return [...this.payments.values()].filter((p) => p.state !== 'declined').length;
  }

  /** The reference of the most recently created payment (tests that need to address it from the provider side). */
  get lastRef(): ProviderRef | undefined {
    const id = [...this.payments.keys()].pop();
    return id ? { provider: 'mock', providerPaymentId: id } : undefined;
  }

  /** How many times `getStatus` was called (resolution of uncertain payments goes through it). */
  get statusQueryCount(): number {
    return this.statusQueries;
  }

  ledger(ref: ProviderRef): Readonly<MockPayment> | undefined {
    return this.payments.get(ref.providerPaymentId);
  }

  /** Make the settlement file disagree with the platform (reconciliation tests). */
  overrideSettlement(ref: ProviderRef, override: { amountMinor?: bigint; drop?: boolean }): this {
    this.settlementOverrides.set(ref.providerPaymentId, override);
    return this;
  }

  addSettlementLine(line: SettlementLine): this {
    this.extraSettlementLines.push(line);
    return this;
  }

  // --- adapter -------------------------------------------------------------

  capabilities(_account: ProviderAccount): Capabilities {
    return {
      cardPresent: true,
      cardNotPresent: true,
      preAuth: true,
      tipAdjust: true,
      offlineStoreAndForward: true,
      offlineModes: { cloud: 'none', lan: 'local_terminal_api', sdk: 'sdk' },
      offlineExcludedSchemes: ['amex', 'eftpos', 'swipe'],
      leastCostRouting: true,
      refundsWithoutOriginal: false,
      surcharging: true,
      certificationStatus: 'not_required',
      currencies: ['AUD', 'NZD', 'USD'],
    };
  }

  async createPayment(req: PaymentRequest, idem: IdempotencyKey): Promise<ProviderResult> {
    return this.once('createPayment', idem, () => {
      const outcome = this.nextOutcome('createPayment', req.amount);
      if (outcome === 'timeout') throw new ProviderTimeoutError('mock');
      if (outcome === 'decline')
        return { outcome: 'declined', code: 'do_not_honour', message: 'Mock decline' };
      const ref: ProviderRef = { provider: 'mock', providerPaymentId: `mock_${++this.sequence}` };
      if (outcome === 'uncertain_then_declined') {
        this.payments.set(ref.providerPaymentId, {
          state: 'declined',
          amount: req.amount,
          refunded: 0n,
          capturedAt: null,
          refunds: [],
          metadata: req.metadata ?? {},
          reference: req.reference,
        });
        return { outcome: 'uncertain', ref, reason: 'Mock timeout after submit' };
      }
      this.payments.set(ref.providerPaymentId, {
        state: req.capture === 'auto' ? 'captured' : 'authorized',
        amount: req.amount,
        refunded: 0n,
        capturedAt: req.capture === 'auto' ? this.clock() : null,
        refunds: [],
        metadata: req.metadata ?? {},
        reference: req.reference,
      });
      if (outcome === 'uncertain_then_approved')
        return { outcome: 'uncertain', ref, reason: 'Mock timeout after submit' };
      return {
        outcome: 'approved',
        ref,
        amount: req.amount,
        authCode: `A${String(this.sequence).padStart(5, '0')}`,
        masked: {
          scheme: 'visa',
          last4: '4242',
          entryMode: 'contactless',
          aid: 'A0000000031010',
          applicationLabel: 'VISA CREDIT',
          cardholderVerification: 'none',
          terminalReceiptText: `MOCK TERMINAL\nVISA ****4242\nAPPROVED ${req.amount.amountMinor} ${req.amount.currency}`,
        },
      };
    });
  }

  async capture(ref: ProviderRef, amount: Money, idem: IdempotencyKey): Promise<ProviderResult> {
    return this.once('capture', idem, () => {
      const outcome = this.nextOutcome('capture', amount);
      if (outcome === 'timeout') throw new ProviderTimeoutError('mock');
      const payment = this.payments.get(ref.providerPaymentId);
      if (!payment || payment.state !== 'authorized') {
        return { outcome: 'declined', ref, code: 'invalid_state', message: 'Nothing to capture' };
      }
      if (amount.amountMinor > payment.amount.amountMinor) {
        return {
          outcome: 'declined',
          ref,
          code: 'amount_exceeds_auth',
          message: 'Capture exceeds authorization',
        };
      }
      if (outcome === 'decline')
        return { outcome: 'declined', ref, code: 'capture_refused', message: 'Mock decline' };
      payment.state = 'captured';
      payment.amount = amount;
      payment.capturedAt = this.clock();
      if (outcome.startsWith('uncertain'))
        return { outcome: 'uncertain', ref, reason: 'Mock timeout after capture' };
      return { outcome: 'approved', ref, amount };
    });
  }

  async refund(ref: ProviderRef, amount: Money, idem: IdempotencyKey): Promise<ProviderResult> {
    return this.once('refund', idem, () => {
      const outcome = this.nextOutcome('refund', amount);
      if (outcome === 'timeout') throw new ProviderTimeoutError('mock');
      const payment = this.payments.get(ref.providerPaymentId);
      if (!payment || (payment.state !== 'captured' && payment.state !== 'refunded')) {
        return { outcome: 'declined', ref, code: 'invalid_state', message: 'Nothing to refund' };
      }
      if (payment.refunded + amount.amountMinor > payment.amount.amountMinor) {
        return {
          outcome: 'declined',
          ref,
          code: 'amount_exceeds_capture',
          message: 'Refund exceeds captured amount',
        };
      }
      if (outcome === 'decline')
        return { outcome: 'declined', ref, code: 'refund_refused', message: 'Mock decline' };
      payment.refunded += amount.amountMinor;
      const refundId = `mock_re_${++this.sequence}`;
      payment.refunds.push({ id: refundId, amount: amount.amountMinor, at: this.clock() });
      if (payment.refunded === payment.amount.amountMinor) payment.state = 'refunded';
      if (outcome.startsWith('uncertain'))
        return { outcome: 'uncertain', ref, reason: 'Mock timeout after refund' };
      return {
        outcome: 'approved',
        ref: { provider: 'mock', providerPaymentId: refundId },
        amount,
      };
    });
  }

  /** Release an authorisation, or void a captured payment in the same batch (docs/01 §7.3 captured → reversed). */
  async reverse(ref: ProviderRef, idem: IdempotencyKey): Promise<ProviderResult> {
    return this.once('reverse', idem, () => {
      const outcome = this.nextOutcome('reverse', { amountMinor: 0n, currency: 'XXX' });
      if (outcome === 'timeout') throw new ProviderTimeoutError('mock');
      const payment = this.payments.get(ref.providerPaymentId);
      if (!payment || (payment.state !== 'authorized' && payment.state !== 'captured')) {
        return { outcome: 'declined', ref, code: 'invalid_state', message: 'Nothing to reverse' };
      }
      if (payment.state === 'captured' && payment.refunded > 0n) {
        return { outcome: 'declined', ref, code: 'partially_refunded', message: 'Refund instead' };
      }
      if (outcome === 'decline')
        return { outcome: 'declined', ref, code: 'reverse_refused', message: 'Mock decline' };
      payment.state = 'reversed';
      return { outcome: 'approved', ref, amount: payment.amount };
    });
  }

  async getStatus(ref: ProviderRef): Promise<ProviderStatus> {
    this.statusQueries += 1;
    const payment = this.payments.get(ref.providerPaymentId);
    return payment
      ? { state: payment.state, amount: payment.amount, refundedMinor: payment.refunded }
      : { state: 'unknown' };
  }

  // --- webhooks ------------------------------------------------------------

  /** Build a signed webhook for a payment, as the real provider would deliver it. */
  emitWebhook(
    type: WebhookEventType,
    ref: ProviderRef,
    options: {
      readonly at?: Date;
      readonly externalEventId?: string;
      readonly secret?: string;
    } = {},
  ): SignedWebhook {
    const payment = this.payments.get(ref.providerPaymentId);
    const at = options.at ?? this.clock();
    const externalEventId = options.externalEventId ?? `evt_mock_${++this.eventSequence}`;
    const body = {
      id: externalEventId,
      type,
      created: Math.floor(at.getTime() / 1000),
      data: {
        object: {
          id: ref.providerPaymentId,
          amount: payment ? payment.amount.amountMinor.toString() : null,
          currency: payment?.amount.currency ?? null,
          amount_refunded: payment ? payment.refunded.toString() : null,
          status: payment?.state ?? 'unknown',
          metadata: payment?.metadata ?? {},
          // deliberately present so the redaction path is exercised end to end
          card: { brand: 'visa', last4: '4242' },
        },
      },
    };
    const rawBody = JSON.stringify(body);
    const signature = signWebhookPayload(
      rawBody,
      options.secret ?? this.webhookSecret,
      Math.floor(at.getTime() / 1000),
    );
    return {
      headers: { [MOCK_WEBHOOK_HEADER]: signature, 'content-type': 'application/json' },
      rawBody,
      externalEventId,
    };
  }

  verifyWebhook(
    headers: WebhookHeaders,
    rawBody: string | Buffer,
    secret: string,
  ): WebhookEvent | InvalidSignature {
    const verification = verifyWebhookSignature(
      headerValue(headers, MOCK_WEBHOOK_HEADER),
      rawBody,
      secret,
      { nowSeconds: Math.floor(this.clock().getTime() / 1000) },
    );
    if (!verification.ok)
      return { kind: 'invalid_signature', provider: 'mock', reason: verification.reason };
    let parsed: {
      id?: string;
      type?: string;
      created?: number;
      data?: { object?: Record<string, unknown> };
    };
    try {
      parsed = JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'));
    } catch {
      return { kind: 'invalid_signature', provider: 'mock', reason: 'bad_payload' };
    }
    if (!parsed.id || !parsed.type)
      return { kind: 'invalid_signature', provider: 'mock', reason: 'bad_payload' };
    const object = parsed.data?.object ?? {};
    const amount = typeof object.amount === 'string' ? BigInt(object.amount) : undefined;
    const currency = typeof object.currency === 'string' ? object.currency : undefined;
    const refunded =
      typeof object.amount_refunded === 'string' ? BigInt(object.amount_refunded) : undefined;
    const types: readonly WebhookEventType[] = [
      'payment.authorized',
      'payment.captured',
      'payment.declined',
      'payment.reversed',
      'refund.succeeded',
      'refund.failed',
      'dispute.opened',
    ];
    const type = (types as readonly string[]).includes(parsed.type)
      ? (parsed.type as WebhookEventType)
      : 'unknown';
    return {
      kind: 'event',
      provider: 'mock',
      externalEventId: parsed.id,
      type,
      rawType: parsed.type,
      occurredAt: new Date((parsed.created ?? verification.timestampSeconds) * 1000),
      ...(typeof object.id === 'string'
        ? { ref: { provider: 'mock', providerPaymentId: object.id } }
        : {}),
      ...(amount !== undefined && currency ? { amount: { amountMinor: amount, currency } } : {}),
      ...(refunded !== undefined ? { refundedMinor: refunded } : {}),
      metadata: (object.metadata as Record<string, string> | undefined) ?? {},
      payload: redactForStorage(parsed) as Record<string, unknown>,
    };
  }

  // --- settlement ----------------------------------------------------------

  async settlementBatch(period: SettlementPeriod): Promise<SettlementBatch | null> {
    return {
      externalId: `settle_${period.account.id}_${period.from.toISOString()}_${period.to.toISOString()}`,
      currency: period.account.currency,
      periodStart: period.from,
      periodEnd: period.to,
      paidOutAt: period.to,
    };
  }

  async *importSettlement(period: SettlementPeriod): AsyncIterable<SettlementLine> {
    const inWindow = (at: Date | null) => at !== null && at >= period.from && at < period.to;
    for (const [id, payment] of this.payments) {
      if (payment.amount.currency !== period.account.currency) continue;
      const override = this.settlementOverrides.get(id);
      if (override?.drop) continue;
      if (
        (payment.state === 'captured' || payment.state === 'refunded') &&
        inWindow(payment.capturedAt)
      ) {
        const amountMinor = override?.amountMinor ?? payment.amount.amountMinor;
        yield {
          externalRef: `${id}:capture`,
          kind: 'capture',
          amount: { amountMinor, currency: payment.amount.currency },
          feeMinor: this.feeFor(amountMinor),
          occurredAt: payment.capturedAt!,
          ref: { provider: 'mock', providerPaymentId: id },
          metadata: payment.metadata,
        };
      }
      for (const refund of payment.refunds) {
        if (!inWindow(refund.at)) continue;
        yield {
          externalRef: `${refund.id}:refund`,
          kind: 'refund',
          amount: { amountMinor: -refund.amount, currency: payment.amount.currency },
          feeMinor: 0n,
          occurredAt: refund.at,
          ref: { provider: 'mock', providerPaymentId: refund.id },
          metadata: payment.metadata,
        };
      }
    }
    for (const line of this.extraSettlementLines) {
      if (inWindow(line.occurredAt)) yield line;
    }
  }

  // --- internals -----------------------------------------------------------

  private nextOutcome(operation: MockOperation, amount: Money): MockOutcome {
    const queue = this.scripts.get(operation);
    const scripted = queue?.shift();
    if (scripted === 'timeout_after_submit') {
      this.throwAfterRecording = true;
      return 'approve';
    }
    if (scripted) return scripted;
    const tail = ((amount.amountMinor % 100n) + 100n) % 100n;
    if (tail === 99n) return 'decline';
    if (tail === 98n) return 'uncertain_then_approved';
    return 'approve';
  }

  private once(
    operation: MockOperation,
    idem: IdempotencyKey,
    compute: () => ProviderResult,
  ): ProviderResult {
    this.calls.push({ operation, idem });
    const cached = this.idempotent.get(idem);
    if (cached) return cached;
    this.throwAfterRecording = false;
    const result = compute(); // a thrown timeout is not cached: the provider never saw it
    this.idempotent.set(idem, result);
    if (this.throwAfterRecording) {
      this.throwAfterRecording = false;
      throw new ProviderTimeoutError(
        'mock',
        'Mock timeout after the provider recorded the operation',
      );
    }
    return result;
  }
}

export function newMockReference(): string {
  return randomUUID();
}
