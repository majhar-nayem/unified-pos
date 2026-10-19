import { describe, expect, it } from 'vitest';

import { PAYMENTS_CONFIG_DEFAULTS, paymentsConfigFromEnv } from '../payments.config.js';
import { EnvPaymentSecrets, StaticPaymentSecrets } from './secrets.port.js';

describe('EnvPaymentSecrets', () => {
  it('reads a per-reference secret from the process environment, never from the database', async () => {
    const secrets = new EnvPaymentSecrets({ PAYMENTS_WEBHOOK_SECRET__STRIPE_MAIN_AU: 'whsec_a' });
    expect(
      await secrets.webhookSecret({ provider: 'stripe', credentialsRef: 'stripe/main-au' }),
    ).toBe('whsec_a');
    expect(
      await secrets.webhookSecret({ provider: 'adyen', credentialsRef: 'adyen/other' }),
    ).toBeNull();
  });

  it('stripe falls back to STRIPE_WEBHOOK_SECRET; the mock default exists only outside production', async () => {
    expect(
      await new EnvPaymentSecrets({ STRIPE_WEBHOOK_SECRET: 'whsec_s' }).webhookSecret({
        provider: 'stripe',
        credentialsRef: 'x',
      }),
    ).toBe('whsec_s');
    expect(
      await new EnvPaymentSecrets({ NODE_ENV: 'test' }).webhookSecret({
        provider: 'mock',
        credentialsRef: 'x',
      }),
    ).toBe('whsec_mock_test_secret');
    expect(
      await new EnvPaymentSecrets({ NODE_ENV: 'production' }).webhookSecret({
        provider: 'mock',
        credentialsRef: 'x',
      }),
    ).toBeNull();
  });

  it('StaticPaymentSecrets looks up by credentials reference', async () => {
    const secrets = new StaticPaymentSecrets({ 'a/b': 'secret' });
    expect(await secrets.webhookSecret({ credentialsRef: 'a/b' })).toBe('secret');
    expect(await secrets.webhookSecret({ credentialsRef: 'c' })).toBeNull();
  });
});

describe('paymentsConfigFromEnv', () => {
  it('defaults keep the uncertain-resolution latency under 60 s (one sweep interval plus a provider round trip)', () => {
    expect(paymentsConfigFromEnv({})).toEqual(PAYMENTS_CONFIG_DEFAULTS);
    expect(PAYMENTS_CONFIG_DEFAULTS.sweepIntervalMs * 2).toBeLessThan(60_000);
  });

  it('reads overrides and rejects nonsense at boot', () => {
    expect(
      paymentsConfigFromEnv({
        PAYMENTS_STUCK_AFTER_MS: '5000',
        PAYMENTS_SWEEP_INTERVAL_MS: '2000',
      }),
    ).toMatchObject({ stuckAfterMs: 5000, sweepIntervalMs: 2000 });
    expect(() => paymentsConfigFromEnv({ PAYMENTS_STUCK_AFTER_MS: '0' })).toThrow(
      /positive integer/,
    );
    expect(() => paymentsConfigFromEnv({ PAYMENTS_SWEEP_INTERVAL_MS: 'soon' })).toThrow(
      /positive integer/,
    );
  });
});
