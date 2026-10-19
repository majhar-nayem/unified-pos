import {
  MockPaymentProvider,
  MockTerminalAdapter,
  type PaymentProviderAdapter,
  StripeProviderAdapter,
  type TerminalAdapter,
  stripeOptionsFromEnv,
} from '@pos/payments-sdk';

import { ConflictError } from '../../kernel/public/index.js';

/** Adapter lookup by provider key. Tests register a scripted mock; production builds the defaults from the environment. */
export class ProviderRegistry {
  private readonly adapters = new Map<string, PaymentProviderAdapter>();
  private readonly terminals = new Map<string, TerminalAdapter>();

  register(adapter: PaymentProviderAdapter, terminal?: TerminalAdapter): this {
    this.adapters.set(adapter.key, adapter);
    if (terminal) this.terminals.set(adapter.key, terminal);
    return this;
  }

  find(provider: string): PaymentProviderAdapter | null {
    return this.adapters.get(provider) ?? null;
  }

  adapter(provider: string): PaymentProviderAdapter {
    const adapter = this.find(provider);
    if (!adapter)
      throw new ConflictError(
        'PROVIDER_ADAPTER_UNAVAILABLE',
        `No adapter is installed for provider "${provider}"`,
      );
    return adapter;
  }

  terminal(provider: string): TerminalAdapter | null {
    return this.terminals.get(provider) ?? null;
  }
}

export const PROVIDER_REGISTRY = Symbol('PROVIDER_REGISTRY');

/** mock (always) and stripe (test key from the environment, simulated without one). */
export function defaultProviderRegistry(env: NodeJS.ProcessEnv = process.env): ProviderRegistry {
  const mock = new MockPaymentProvider();
  return new ProviderRegistry()
    .register(mock, new MockTerminalAdapter(mock))
    .register(new StripeProviderAdapter(stripeOptionsFromEnv(env)));
}
