import { money } from '@pos/domain-core';
import { describe, expect, it } from 'vitest';

import { idempotencyKey, type ProviderAccount } from './adapter.js';
import {
  STRIPE_SIGNATURE_HEADER,
  StripeProviderAdapter,
  stripeOptionsFromEnv,
} from './stripe-provider.js';
import { signWebhookPayload } from './webhook-signature.js';

const account: ProviderAccount = {
  id: 'acc',
  provider: 'stripe',
  currency: 'AUD',
  credentialsRef: 'stripe-main',
};

describe('StripeProviderAdapter', () => {
  it('is simulated without a key and answers through the internal mock with stripe refs', async () => {
    const stripe = new StripeProviderAdapter(stripeOptionsFromEnv({}));
    expect(stripe.simulated).toBe(true);
    const result = await stripe.createPayment(
      {
        account,
        amount: money(1500, 'AUD'),
        intentId: 'pi',
        capture: 'manual',
        reference: 'ORD-9',
      },
      idempotencyKey('stripe-sim-1'),
    );
    expect(result.outcome).toBe('approved');
    if (result.outcome !== 'approved') throw new Error();
    expect(result.ref.provider).toBe('stripe');
    expect(
      (await stripe.capture(result.ref, money(1500, 'AUD'), idempotencyKey('stripe-cap-1')))
        .outcome,
    ).toBe('approved');
    expect((await stripe.getStatus(result.ref)).state).toBe('captured');
    expect(stripe.capabilities(account).offlineModes).toEqual({
      cloud: 'none',
      lan: 'none',
      sdk: 'sdk',
    });
  });

  it('refuses live keys in this phase and accepts test keys from the environment only', () => {
    expect(() => stripeOptionsFromEnv({ STRIPE_SECRET_KEY: 'sk_live_abc' })).toThrow(/test-mode/);
    const options = stripeOptionsFromEnv({
      STRIPE_SECRET_KEY: 'sk_test_abc',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
    });
    expect(options).toEqual({ secretKey: 'sk_test_abc', webhookSecret: 'whsec_x' });
    expect(new StripeProviderAdapter(options).simulated).toBe(false);
  });

  it('verifies Stripe-Signature over the raw body and maps event types', () => {
    const now = new Date('2026-10-18T10:00:00Z');
    const stripe = new StripeProviderAdapter({ webhookSecret: 'whsec_x', clock: () => now });
    const body = JSON.stringify({
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      created: 1792231200,
      data: {
        object: {
          id: 'pi_1',
          amount: 1500,
          currency: 'aud',
          metadata: { tenantId: 't', intentId: 'i' },
          payment_method_details: { card: { last4: '4242' } },
        },
      },
    });
    const header = signWebhookPayload(body, 'whsec_x', Math.floor(now.getTime() / 1000));
    const event = stripe.verifyWebhook({ [STRIPE_SIGNATURE_HEADER]: header }, body, 'whsec_x');
    expect(event).toMatchObject({
      kind: 'event',
      type: 'payment.captured',
      externalEventId: 'evt_1',
      ref: { provider: 'stripe', providerPaymentId: 'pi_1' },
      amount: money(1500, 'AUD'),
    });
    expect(
      stripe.verifyWebhook(
        { [STRIPE_SIGNATURE_HEADER]: header },
        body.replace('1500', '1501'),
        'whsec_x',
      ),
    ).toMatchObject({ kind: 'invalid_signature', reason: 'mismatch' });
    expect(stripe.verifyWebhook({}, body, 'whsec_x')).toMatchObject({
      kind: 'invalid_signature',
      reason: 'missing_header',
    });
  });

  it('with a test key sends Idempotency-Key and maps PaymentIntent statuses (fetch stubbed)', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchStub: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(
        JSON.stringify({
          id: 'pi_live',
          status: 'requires_capture',
          amount: 1500,
          currency: 'aud',
          latest_charge: null,
        }),
        { status: 200 },
      );
    };
    const stripe = new StripeProviderAdapter({ secretKey: 'sk_test_abc', fetch: fetchStub });
    const result = await stripe.createPayment(
      {
        account,
        amount: money(1500, 'AUD'),
        intentId: 'pi',
        capture: 'manual',
        reference: 'ORD-9',
        metadata: { tenantId: 't' },
      },
      idempotencyKey('stripe-live-1'),
    );
    expect(result).toMatchObject({
      outcome: 'approved',
      ref: { provider: 'stripe', providerPaymentId: 'pi_live' },
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('stripe-live-1');
    expect(headers.authorization).toBe('Bearer sk_test_abc');
    expect(String(calls[0]!.init.body)).toContain('capture_method=manual');
    expect(String(calls[0]!.init.body)).toContain('metadata%5BtenantId%5D=t');
  });
});
