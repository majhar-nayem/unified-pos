import { money } from '@pos/domain-core';
import { describe, expect, it } from 'vitest';

import { idempotencyKey, type ProviderAccount, ProviderTimeoutError } from './adapter.js';
import { MOCK_WEBHOOK_HEADER, MockPaymentProvider } from './mock-provider.js';

const account: ProviderAccount = {
  id: 'acc',
  provider: 'mock',
  currency: 'AUD',
  credentialsRef: 'mock',
};
const base = { account, intentId: 'pi', capture: 'auto' as const, reference: 'r' };

describe('MockPaymentProvider', () => {
  it('approves, captures and refunds with idempotent replays', async () => {
    const provider = new MockPaymentProvider();
    const idem = idempotencyKey('create-0001');
    const req = {
      ...base,
      amount: money(1000, 'AUD'),
      intentId: 'pi_1',
      capture: 'manual' as const,
    };
    const first = await provider.createPayment(req, idem);
    const replay = await provider.createPayment(req, idem);
    expect(first).toBe(replay);
    expect(provider.chargeCount).toBe(1);
    if (first.outcome !== 'approved') throw new Error('expected approval');
    expect(first.masked?.last4).toBe('4242');

    const captured = await provider.capture(
      first.ref,
      money(900, 'AUD'),
      idempotencyKey('capture-0001'),
    );
    expect(captured.outcome).toBe('approved');
    expect(await provider.getStatus(first.ref)).toEqual({
      state: 'captured',
      amount: money(900, 'AUD'),
      refundedMinor: 0n,
    });

    const tooMuch = await provider.refund(
      first.ref,
      money(901, 'AUD'),
      idempotencyKey('refund-0001'),
    );
    expect(tooMuch.outcome).toBe('declined');
    const ok = await provider.refund(first.ref, money(900, 'AUD'), idempotencyKey('refund-0002'));
    expect(ok.outcome).toBe('approved');
    expect((await provider.getStatus(first.ref)).state).toBe('refunded');
  });

  it('simulates declines and uncertain outcomes from the amount', async () => {
    const provider = new MockPaymentProvider();
    expect(
      (
        await provider.createPayment(
          { ...base, amount: money(1099, 'AUD') },
          idempotencyKey('k-declined'),
        )
      ).outcome,
    ).toBe('declined');
    const uncertain = await provider.createPayment(
      { ...base, amount: money(1098, 'AUD') },
      idempotencyKey('k-uncertain'),
    );
    expect(uncertain.outcome).toBe('uncertain');
    // the provider did record the charge: only getStatus reveals it
    if (uncertain.outcome !== 'uncertain' || !uncertain.ref) throw new Error('expected ref');
    expect((await provider.getStatus(uncertain.ref)).state).toBe('captured');
    expect(await provider.getStatus({ provider: 'mock', providerPaymentId: 'nope' })).toEqual({
      state: 'unknown',
    });
  });

  it('follows a script: approve, decline, timeout, uncertain-then-approved, uncertain-then-declined', async () => {
    const provider = new MockPaymentProvider().script(
      'createPayment',
      'approve',
      'decline',
      'timeout',
      'uncertain_then_approved',
      'uncertain_then_declined',
    );
    const call = (n: number) =>
      provider.createPayment({ ...base, amount: money(500, 'AUD') }, idempotencyKey(`script-${n}`));
    expect((await call(1)).outcome).toBe('approved');
    expect((await call(2)).outcome).toBe('declined');
    await expect(call(3)).rejects.toBeInstanceOf(ProviderTimeoutError);
    // a timeout is not cached: the same key retried reaches the next scripted outcome
    const fourth = await call(3);
    expect(fourth.outcome).toBe('uncertain');
    if (fourth.outcome !== 'uncertain' || !fourth.ref) throw new Error('expected ref');
    expect((await provider.getStatus(fourth.ref)).state).toBe('captured');
    const fifth = await call(5);
    if (fifth.outcome !== 'uncertain' || !fifth.ref) throw new Error('expected ref');
    expect((await provider.getStatus(fifth.ref)).state).toBe('declined');
    // script exhausted → amount rule
    expect((await call(6)).outcome).toBe('approved');
    expect(provider.callLog.filter((c) => c.operation === 'createPayment')).toHaveLength(6);
  });

  it('timeout_after_submit: the provider records the charge, the caller sees a timeout, a same-key replay returns the original result', async () => {
    const provider = new MockPaymentProvider().script('createPayment', 'timeout_after_submit');
    const key = idempotencyKey('late-timeout-1');
    const req = { ...base, amount: money(700, 'AUD') };
    await expect(provider.createPayment(req, key)).rejects.toBeInstanceOf(ProviderTimeoutError);
    expect(provider.chargeCount).toBe(1); // the provider did charge
    const replay = await provider.createPayment(req, key);
    expect(replay.outcome).toBe('approved');
    expect(provider.chargeCount).toBe(1); // and the replay did not charge again
    expect(provider.statusQueryCount).toBe(0);
  });

  it('reverses an authorisation and voids a captured payment, never a partially refunded one', async () => {
    const provider = new MockPaymentProvider();
    const auth = await provider.createPayment(
      { ...base, amount: money(100, 'AUD'), capture: 'manual' },
      idempotencyKey('rev-auth-1'),
    );
    if (auth.outcome !== 'approved') throw new Error();
    expect((await provider.reverse(auth.ref, idempotencyKey('reverse-1'))).outcome).toBe(
      'approved',
    );
    expect((await provider.getStatus(auth.ref)).state).toBe('reversed');

    const sale = await provider.createPayment(
      { ...base, amount: money(100, 'AUD') },
      idempotencyKey('rev-sale-1'),
    );
    if (sale.outcome !== 'approved') throw new Error();
    expect((await provider.reverse(sale.ref, idempotencyKey('reverse-2'))).outcome).toBe(
      'approved',
    );

    const partial = await provider.createPayment(
      { ...base, amount: money(100, 'AUD') },
      idempotencyKey('rev-sale-2'),
    );
    if (partial.outcome !== 'approved') throw new Error();
    await provider.refund(partial.ref, money(10, 'AUD'), idempotencyKey('rev-refund-1'));
    expect((await provider.reverse(partial.ref, idempotencyKey('reverse-3'))).outcome).toBe(
      'declined',
    );
  });

  it('emits signed webhooks that verify, and rejects forged, stale and replayed-with-tamper bodies', async () => {
    const now = new Date('2026-10-18T10:00:00Z');
    const provider = new MockPaymentProvider({ webhookSecret: 'whsec_test', clock: () => now });
    const sale = await provider.createPayment(
      { ...base, amount: money(2500, 'AUD'), metadata: { tenantId: 't-1', intentId: 'i-1' } },
      idempotencyKey('wh-sale-1'),
    );
    if (sale.outcome !== 'approved') throw new Error();
    const hook = provider.emitWebhook('payment.captured', sale.ref);
    const event = provider.verifyWebhook(hook.headers, hook.rawBody, 'whsec_test');
    expect(event.kind).toBe('event');
    if (event.kind !== 'event') throw new Error();
    expect(event).toMatchObject({
      type: 'payment.captured',
      externalEventId: hook.externalEventId,
      ref: sale.ref,
      amount: money(2500, 'AUD'),
      metadata: { tenantId: 't-1', intentId: 'i-1' },
    });
    expect(JSON.stringify(event.payload)).not.toContain('4242424242424242');

    expect(provider.verifyWebhook(hook.headers, hook.rawBody, 'whsec_other')).toMatchObject({
      kind: 'invalid_signature',
      reason: 'mismatch',
    });
    expect(provider.verifyWebhook({}, hook.rawBody, 'whsec_test')).toMatchObject({
      kind: 'invalid_signature',
      reason: 'missing_header',
    });
    expect(
      provider.verifyWebhook({ [MOCK_WEBHOOK_HEADER]: 'garbage' }, hook.rawBody, 'whsec_test'),
    ).toMatchObject({ reason: 'malformed_header' });
    expect(
      provider.verifyWebhook(hook.headers, hook.rawBody.replace('2500', '2501'), 'whsec_test'),
    ).toMatchObject({ reason: 'mismatch' });
    const stale = provider.emitWebhook('payment.captured', sale.ref, {
      at: new Date(now.getTime() - 3_600_000),
    });
    expect(provider.verifyWebhook(stale.headers, stale.rawBody, 'whsec_test')).toMatchObject({
      reason: 'stale_timestamp',
    });
  });

  it('produces settlement lines for captures and refunds in the period, honouring overrides', async () => {
    const t0 = new Date('2026-10-01T00:00:00Z');
    let now = t0;
    const provider = new MockPaymentProvider({ clock: () => now });
    const a = await provider.createPayment(
      { ...base, amount: money(1000, 'AUD') },
      idempotencyKey('settle-a'),
    );
    now = new Date('2026-10-01T12:00:00Z');
    const b = await provider.createPayment(
      { ...base, amount: money(2000, 'AUD') },
      idempotencyKey('settle-b'),
    );
    if (a.outcome !== 'approved' || b.outcome !== 'approved') throw new Error();
    await provider.refund(b.ref, money(500, 'AUD'), idempotencyKey('settle-b-refund'));
    now = new Date('2026-10-03T00:00:00Z');
    const c = await provider.createPayment(
      { ...base, amount: money(3000, 'AUD') },
      idempotencyKey('settle-c'),
    );
    if (c.outcome !== 'approved') throw new Error();
    provider.overrideSettlement(a.ref, { amountMinor: 999n });

    const lines = [];
    for await (const line of provider.importSettlement({
      account,
      from: t0,
      to: new Date('2026-10-02T00:00:00Z'),
    }))
      lines.push(line);
    expect(lines.map((l) => [l.kind, l.amount.amountMinor])).toEqual([
      ['capture', 999n],
      ['capture', 2000n],
      ['refund', -500n],
    ]);
    expect(lines[1]!.feeMinor).toBe(30n + 35n);
  });
});
