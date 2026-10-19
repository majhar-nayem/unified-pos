/**
 * Secret resolution for provider accounts. `credentials_ref` is a key into the secret store
 * (Secrets Manager in production), never a secret. The payments deployable runs with its own
 * credentials; the API process does not need them.
 */
export interface PaymentSecretsPort {
  /** The endpoint signing secret used to verify this account's webhooks, or null when none is configured. */
  webhookSecret(account: {
    readonly provider: string;
    readonly credentialsRef: string;
  }): Promise<string | null>;
}

export const PAYMENT_SECRETS = Symbol('PAYMENT_SECRETS');

/** `PAYMENTS_WEBHOOK_SECRET__<REF>` (non-alphanumerics → `_`, upper case); stripe also reads STRIPE_WEBHOOK_SECRET. */
export class EnvPaymentSecrets implements PaymentSecretsPort {
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly mockSecret = 'whsec_mock_test_secret',
  ) {}

  async webhookSecret(account: {
    provider: string;
    credentialsRef: string;
  }): Promise<string | null> {
    const name = `PAYMENTS_WEBHOOK_SECRET__${account.credentialsRef.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
    const fromRef = this.env[name]?.trim();
    if (fromRef) return fromRef;
    if (account.provider === 'stripe') return this.env.STRIPE_WEBHOOK_SECRET?.trim() || null;
    if (account.provider === 'mock' && this.env.NODE_ENV !== 'production') return this.mockSecret;
    return null;
  }
}

export class StaticPaymentSecrets implements PaymentSecretsPort {
  constructor(private readonly secrets: Readonly<Record<string, string>>) {}

  async webhookSecret(account: { credentialsRef: string }): Promise<string | null> {
    return this.secrets[account.credentialsRef] ?? null;
  }
}
