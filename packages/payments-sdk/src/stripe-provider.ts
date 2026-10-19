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
import { MockPaymentProvider } from './mock-provider.js';
import { redactForStorage } from './redaction.js';
import { headerValue, verifyWebhookSignature } from './webhook-signature.js';

export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';

export interface StripeProviderOptions {
  /** Test-mode secret key (`sk_test_…`). Absent → the adapter is `simulated`. Never logged, never stored. */
  readonly secretKey?: string | undefined;
  /** Endpoint signing secret (`whsec_…`) used by verifyWebhook when the caller passes none. */
  readonly webhookSecret?: string | undefined;
  readonly apiBase?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly clock?: () => Date;
}

/** Read Stripe test credentials from the environment only (docs/03 §5 F5: separate secrets, nothing hardcoded). */
export function stripeOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): StripeProviderOptions {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  if (secretKey && !secretKey.startsWith('sk_test_'))
    throw new Error('STRIPE_SECRET_KEY must be a test-mode key (sk_test_…) in this phase');
  return {
    secretKey: secretKey || undefined,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim() || undefined,
  };
}

interface StripeIntent {
  id: string;
  status: string;
  amount: number;
  amount_received?: number;
  amount_capturable?: number;
  currency: string;
  latest_charge?:
    string | { id: string; payment_method_details?: { card?: Record<string, unknown> } } | null;
  last_payment_error?: { code?: string; decline_code?: string; message?: string } | null;
  metadata?: Record<string, string>;
}

/**
 * Stripe PaymentIntents behind the §7.4 interface. With no `secretKey` every call is answered by
 * an internal mock (reported as `simulated: true`), so the skeleton is exercised in CI without
 * credentials; with a test key it issues real REST calls with Stripe's `Idempotency-Key` header.
 * Sandbox contract tests are a nightly job (plan §5 F5), not part of this package's unit tests.
 */
export class StripeProviderAdapter implements PaymentProviderAdapter {
  readonly key = 'stripe' as const;
  readonly simulated: boolean;
  private readonly mock: MockPaymentProvider | null;
  private readonly secretKey: string | null;
  private readonly webhookSecret: string | null;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => Date;

  constructor(options: StripeProviderOptions = {}) {
    this.secretKey = options.secretKey ?? null;
    this.webhookSecret = options.webhookSecret ?? null;
    this.simulated = this.secretKey === null;
    this.mock = this.simulated ? new MockPaymentProvider({ clock: options.clock }) : null;
    this.apiBase = options.apiBase ?? 'https://api.stripe.com';
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetch ?? fetch;
    this.clock = options.clock ?? (() => new Date());
  }

  capabilities(_account: ProviderAccount): Capabilities {
    // docs/01 §7.4 table: Stripe Terminal SDKs support offline; the JS SDK and server-driven mode do not.
    return {
      cardPresent: true,
      cardNotPresent: true,
      preAuth: true,
      tipAdjust: true,
      offlineStoreAndForward: true,
      offlineModes: { cloud: 'none', lan: 'none', sdk: 'sdk' },
      offlineExcludedSchemes: ['swipe', 'eftpos', 'contactless_sca'],
      leastCostRouting: false,
      refundsWithoutOriginal: false,
      surcharging: false,
      certificationStatus: 'not_required',
      currencies: ['AUD', 'NZD', 'USD', 'EUR', 'GBP'],
    };
  }

  async createPayment(req: PaymentRequest, idem: IdempotencyKey): Promise<ProviderResult> {
    if (this.mock) return this.remap(await this.mock.createPayment(req, idem));
    const body = new URLSearchParams({
      amount: req.amount.amountMinor.toString(),
      currency: req.amount.currency.toLowerCase(),
      confirm: 'true',
      capture_method: req.capture === 'auto' ? 'automatic' : 'manual',
      description: req.reference,
      payment_method: req.metadata?.paymentMethod ?? 'pm_card_visa',
      'automatic_payment_methods[enabled]': 'true',
      'automatic_payment_methods[allow_redirects]': 'never',
      'metadata[intentId]': req.intentId,
      'expand[]': 'latest_charge',
    });
    for (const [k, v] of Object.entries(req.metadata ?? {})) body.set(`metadata[${k}]`, v);
    const intent = await this.call<StripeIntent>('POST', '/v1/payment_intents', body, idem);
    return this.toResult(intent);
  }

  async capture(ref: ProviderRef, amount: Money, idem: IdempotencyKey): Promise<ProviderResult> {
    if (this.mock) return this.remap(await this.mock.capture(ref, amount, idem));
    const intent = await this.call<StripeIntent>(
      'POST',
      `/v1/payment_intents/${encodeURIComponent(ref.providerPaymentId)}/capture`,
      new URLSearchParams({ amount_to_capture: amount.amountMinor.toString() }),
      idem,
    );
    return this.toResult(intent);
  }

  async refund(ref: ProviderRef, amount: Money, idem: IdempotencyKey): Promise<ProviderResult> {
    if (this.mock) return this.remap(await this.mock.refund(ref, amount, idem));
    const refund = await this.call<{
      id: string;
      status: string;
      amount: number;
      currency: string;
      failure_reason?: string;
    }>(
      'POST',
      '/v1/refunds',
      new URLSearchParams({
        payment_intent: ref.providerPaymentId,
        amount: amount.amountMinor.toString(),
      }),
      idem,
    );
    if (refund.status === 'succeeded' || refund.status === 'pending')
      return {
        outcome: 'approved',
        ref: { provider: 'stripe', providerPaymentId: refund.id },
        amount,
      };
    return {
      outcome: 'declined',
      ref,
      code: refund.failure_reason ?? refund.status,
      message: 'Refund not accepted',
    };
  }

  async reverse(ref: ProviderRef, idem: IdempotencyKey): Promise<ProviderResult> {
    if (this.mock) return this.remap(await this.mock.reverse(ref, idem));
    const intent = await this.call<StripeIntent>(
      'POST',
      `/v1/payment_intents/${encodeURIComponent(ref.providerPaymentId)}/cancel`,
      new URLSearchParams({ cancellation_reason: 'requested_by_customer' }),
      idem,
    );
    return intent.status === 'canceled'
      ? {
          outcome: 'approved',
          ref,
          amount: { amountMinor: BigInt(intent.amount), currency: intent.currency.toUpperCase() },
        }
      : { outcome: 'declined', ref, code: intent.status, message: 'Cancel refused' };
  }

  async getStatus(ref: ProviderRef): Promise<ProviderStatus> {
    if (this.mock) return this.mock.getStatus(ref);
    try {
      const intent = await this.call<StripeIntent>(
        'GET',
        `/v1/payment_intents/${encodeURIComponent(ref.providerPaymentId)}`,
      );
      const amount = {
        amountMinor: BigInt(intent.amount),
        currency: intent.currency.toUpperCase(),
      };
      switch (intent.status) {
        case 'succeeded':
          return {
            state: 'captured',
            amount: { ...amount, amountMinor: BigInt(intent.amount_received ?? intent.amount) },
          };
        case 'requires_capture':
          return { state: 'authorized', amount };
        case 'canceled':
          return { state: 'reversed', amount };
        case 'requires_payment_method':
          return intent.last_payment_error ? { state: 'declined', amount } : { state: 'unknown' };
        default:
          return { state: 'unknown' };
      }
    } catch (error) {
      if (error instanceof StripeApiError && error.status === 404) return { state: 'unknown' };
      throw error;
    }
  }

  verifyWebhook(
    headers: WebhookHeaders,
    rawBody: string | Buffer,
    secret: string,
  ): WebhookEvent | InvalidSignature {
    const verification = verifyWebhookSignature(
      headerValue(headers, STRIPE_SIGNATURE_HEADER),
      rawBody,
      secret || this.webhookSecret || '',
      {
        nowSeconds: Math.floor(this.clock().getTime() / 1000),
      },
    );
    if (!verification.ok)
      return { kind: 'invalid_signature', provider: 'stripe', reason: verification.reason };
    let parsed: {
      id?: string;
      type?: string;
      created?: number;
      data?: { object?: Record<string, unknown> };
    };
    try {
      parsed = JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'));
    } catch {
      return { kind: 'invalid_signature', provider: 'stripe', reason: 'bad_payload' };
    }
    if (!parsed.id || !parsed.type)
      return { kind: 'invalid_signature', provider: 'stripe', reason: 'bad_payload' };
    const object = parsed.data?.object ?? {};
    const paymentIntent =
      typeof object.payment_intent === 'string'
        ? object.payment_intent
        : typeof object.id === 'string'
          ? object.id
          : undefined;
    const amount = typeof object.amount === 'number' ? BigInt(object.amount) : undefined;
    const currency =
      typeof object.currency === 'string' ? object.currency.toUpperCase() : undefined;
    return {
      kind: 'event',
      provider: 'stripe',
      externalEventId: parsed.id,
      type: STRIPE_EVENT_TYPES[parsed.type] ?? 'unknown',
      rawType: parsed.type,
      occurredAt: new Date((parsed.created ?? verification.timestampSeconds) * 1000),
      ...(paymentIntent ? { ref: { provider: 'stripe', providerPaymentId: paymentIntent } } : {}),
      ...(amount !== undefined && currency ? { amount: { amountMinor: amount, currency } } : {}),
      ...(typeof object.amount_refunded === 'number'
        ? { refundedMinor: BigInt(object.amount_refunded) }
        : {}),
      metadata: (object.metadata as Record<string, string> | undefined) ?? {},
      payload: redactForStorage(parsed) as Record<string, unknown>,
    };
  }

  async settlementBatch(period: SettlementPeriod): Promise<SettlementBatch | null> {
    if (this.mock) return this.mock.settlementBatch(period);
    const payouts = await this.call<{
      data: { id: string; arrival_date: number; currency: string; status: string }[];
    }>(
      'GET',
      `/v1/payouts?limit=1&arrival_date[gte]=${Math.floor(period.from.getTime() / 1000)}&arrival_date[lt]=${Math.floor(period.to.getTime() / 1000)}`,
    );
    const payout = payouts.data[0];
    if (!payout) return null;
    return {
      externalId: payout.id,
      currency: payout.currency.toUpperCase(),
      periodStart: period.from,
      periodEnd: period.to,
      paidOutAt: payout.status === 'paid' ? new Date(payout.arrival_date * 1000) : null,
    };
  }

  async *importSettlement(period: SettlementPeriod): AsyncIterable<SettlementLine> {
    if (this.mock) {
      yield* this.mock.importSettlement(period);
      return;
    }
    let startingAfter: string | undefined;
    for (;;) {
      const page = await this.call<{
        has_more: boolean;
        data: {
          id: string;
          type: string;
          amount: number;
          fee: number;
          currency: string;
          created: number;
          source: string | null;
        }[];
      }>(
        'GET',
        `/v1/balance_transactions?limit=100&created[gte]=${Math.floor(period.from.getTime() / 1000)}&created[lt]=${Math.floor(period.to.getTime() / 1000)}${startingAfter ? `&starting_after=${startingAfter}` : ''}`,
      );
      for (const tx of page.data) {
        const kind = BALANCE_TX_KINDS[tx.type];
        if (!kind) continue;
        yield {
          externalRef: tx.id,
          kind,
          amount: { amountMinor: BigInt(tx.amount), currency: tx.currency.toUpperCase() },
          feeMinor: BigInt(tx.fee),
          occurredAt: new Date(tx.created * 1000),
          ...(tx.source ? { ref: { provider: 'stripe', providerPaymentId: tx.source } } : {}),
        };
      }
      if (!page.has_more || page.data.length === 0) return;
      startingAfter = page.data[page.data.length - 1]!.id;
    }
  }

  // --- internals -----------------------------------------------------------

  private remap(result: ProviderResult): ProviderResult {
    if (result.outcome === 'approved')
      return { ...result, ref: { ...result.ref, provider: 'stripe' } };
    if (result.ref) return { ...result, ref: { ...result.ref, provider: 'stripe' } };
    return result;
  }

  private toResult(intent: StripeIntent): ProviderResult {
    const ref: ProviderRef = { provider: 'stripe', providerPaymentId: intent.id };
    const amount: Money = {
      amountMinor: BigInt(intent.amount),
      currency: intent.currency.toUpperCase(),
    };
    const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
    const card = charge?.payment_method_details?.card;
    const masked =
      card && typeof card.brand === 'string' && typeof card.last4 === 'string'
        ? { scheme: card.brand, last4: card.last4, entryMode: 'online' as const }
        : undefined;
    switch (intent.status) {
      case 'succeeded':
        return {
          outcome: 'approved',
          ref,
          amount: { ...amount, amountMinor: BigInt(intent.amount_received ?? intent.amount) },
          ...(masked ? { masked } : {}),
        };
      case 'requires_capture':
        return { outcome: 'approved', ref, amount, ...(masked ? { masked } : {}) };
      case 'processing':
        return { outcome: 'uncertain', ref, reason: 'Stripe reports processing' };
      case 'canceled':
        return { outcome: 'declined', ref, code: 'canceled', message: 'Payment intent canceled' };
      default:
        return {
          outcome: 'declined',
          ref,
          code:
            intent.last_payment_error?.decline_code ??
            intent.last_payment_error?.code ??
            intent.status,
          message: intent.last_payment_error?.message ?? `Stripe status ${intent.status}`,
        };
    }
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: URLSearchParams,
    idem?: IdempotencyKey,
  ): Promise<T> {
    if (!this.secretKey) throw new Error('Stripe adapter is simulated; no API calls are made');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          'stripe-version': '2025-09-30.clover',
          ...(idem ? { 'idempotency-key': idem } : {}),
        },
        ...(body ? { body: body.toString() } : {}),
        signal: controller.signal,
      });
      const json = (await response.json()) as T & {
        error?: { type?: string; code?: string; message?: string };
      };
      if (!response.ok) {
        throw new StripeApiError(
          response.status,
          json.error?.code ?? json.error?.type ?? 'stripe_error',
          json.error?.message ?? 'Stripe request failed',
        );
      }
      return json;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError')
        throw new ProviderTimeoutError('stripe');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class StripeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StripeApiError';
  }
}

const STRIPE_EVENT_TYPES: Readonly<Record<string, WebhookEventType>> = {
  'payment_intent.amount_capturable_updated': 'payment.authorized',
  'payment_intent.succeeded': 'payment.captured',
  'payment_intent.payment_failed': 'payment.declined',
  'payment_intent.canceled': 'payment.reversed',
  'charge.refunded': 'refund.succeeded',
  'refund.failed': 'refund.failed',
  'charge.dispute.created': 'dispute.opened',
};

const BALANCE_TX_KINDS: Readonly<Record<string, SettlementLine['kind']>> = {
  charge: 'capture',
  payment: 'capture',
  refund: 'refund',
  payment_refund: 'refund',
  adjustment: 'adjustment',
  stripe_fee: 'fee',
};
