import type { Money } from '@pos/domain-core';

/**
 * Provider adapter interface (docs/01-system-architecture.md §7.4). The platform never receives
 * PAN or CVV; adapters return masked data only. Request/response bodies that reach storage go
 * through `redactForStorage` (redaction.ts) first.
 */
export type ProviderKey = 'stripe' | 'adyen' | 'tyro' | 'windcave' | 'linkly' | 'mock';

export interface ProviderAccount {
  readonly id: string;
  readonly provider: ProviderKey;
  readonly currency: string;
  /** Opaque, provider-specific, stored encrypted by the payments deployable. */
  readonly credentialsRef: string;
}

/** Where the adapter runs for a terminal (docs/01 §7.4 table): offline card depends on it, not on the provider. */
export type ConnectionMode = 'cloud' | 'lan' | 'sdk';

/** Offline (store-and-forward) support, per connection mode. */
export type OfflineMode = 'local_terminal_api' | 'sdk' | 'none';

export type CertificationStatus = 'certified' | 'in_progress' | 'not_required' | 'not_started';

/**
 * Amended capability shape (schema comment on payments.payment_provider_accounts.capabilities):
 * offline support is declared per connection mode, excluded schemes are listed so the POS never
 * promises offline acceptance the terminal will refuse (Amex in AU, swiped, EFTPOS-only cards).
 */
export interface Capabilities {
  readonly cardPresent: boolean;
  readonly cardNotPresent: boolean;
  readonly preAuth: boolean;
  readonly tipAdjust: boolean;
  /** Kept for backwards compatibility with the §7.4 prose: true when any mode in `offlineModes` is not 'none'. */
  readonly offlineStoreAndForward: boolean;
  readonly offlineModes: Readonly<Record<ConnectionMode, OfflineMode>>;
  readonly offlineExcludedSchemes: readonly string[];
  readonly leastCostRouting: boolean;
  readonly refundsWithoutOriginal: boolean;
  readonly surcharging: boolean;
  readonly certificationStatus: CertificationStatus;
  readonly currencies: readonly string[];
}

export type IdempotencyKey = string & { readonly __brand: 'IdempotencyKey' };

export function idempotencyKey(value: string): IdempotencyKey {
  if (value.length < 8) throw new TypeError('Idempotency keys must be at least 8 characters');
  return value as IdempotencyKey;
}

export interface PaymentRequest {
  readonly account: ProviderAccount;
  readonly amount: Money;
  readonly intentId: string;
  readonly capture: 'auto' | 'manual';
  readonly reference: string;
  /** Opaque values the provider echoes back in webhooks and settlement (tenant id, intent id). */
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface ProviderRef {
  readonly provider: ProviderKey;
  readonly providerPaymentId: string;
}

export type ProviderResult =
  | {
      readonly outcome: 'approved';
      readonly ref: ProviderRef;
      readonly amount: Money;
      readonly masked?: MaskedCard;
      readonly authCode?: string;
    }
  | {
      readonly outcome: 'declined';
      readonly ref?: ProviderRef;
      readonly code: string;
      readonly message: string;
    }
  | { readonly outcome: 'uncertain'; readonly ref?: ProviderRef; readonly reason: string };

/** Scheme-permitted receipt data only (payments.card_payment_details). */
export interface MaskedCard {
  readonly scheme: string;
  readonly last4: string;
  readonly entryMode?: 'chip' | 'contactless' | 'swipe' | 'keyed' | 'online';
  readonly aid?: string;
  readonly applicationLabel?: string;
  readonly cardholderVerification?: string;
  readonly issuerBank?: string;
  readonly tokenRef?: string;
  readonly schemeReference?: string;
  readonly terminalReceiptText?: string;
}

export type ProviderStatus =
  | {
      readonly state: 'authorized' | 'captured' | 'refunded' | 'reversed' | 'declined';
      readonly amount: Money;
      readonly refundedMinor?: bigint;
    }
  | { readonly state: 'unknown' };

/** Thrown by adapters when the provider did not answer in time: the outcome is unknown, never "declined". */
export class ProviderTimeoutError extends Error {
  constructor(
    public readonly provider: ProviderKey,
    message = 'Provider did not respond in time',
  ) {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}

// --- webhooks -------------------------------------------------------------

export type WebhookHeaders = Readonly<Record<string, string | string[] | undefined>>;

export type WebhookEventType =
  | 'payment.authorized'
  | 'payment.captured'
  | 'payment.declined'
  | 'payment.reversed'
  | 'refund.succeeded'
  | 'refund.failed'
  | 'dispute.opened'
  | 'unknown';

export interface WebhookEvent {
  readonly kind: 'event';
  readonly provider: ProviderKey;
  /** Provider-unique id used for replay protection (payments.webhook_inbox UNIQUE (provider, external_event_id)). */
  readonly externalEventId: string;
  readonly type: WebhookEventType;
  readonly rawType: string;
  readonly occurredAt: Date;
  readonly ref?: ProviderRef;
  readonly amount?: Money;
  readonly refundedMinor?: bigint;
  readonly metadata: Readonly<Record<string, string>>;
  /** Parsed payload, already safe to store (adapters redact before returning). */
  readonly payload: Record<string, unknown>;
}

export interface InvalidSignature {
  readonly kind: 'invalid_signature';
  readonly provider: ProviderKey;
  readonly reason:
    'missing_header' | 'malformed_header' | 'stale_timestamp' | 'mismatch' | 'bad_payload';
}

// --- settlement -----------------------------------------------------------

export interface SettlementPeriod {
  readonly account: ProviderAccount;
  readonly from: Date;
  readonly to: Date;
}

export interface SettlementLine {
  readonly externalRef: string;
  readonly kind: 'capture' | 'refund' | 'chargeback' | 'fee' | 'adjustment';
  readonly amount: Money;
  readonly feeMinor: bigint;
  readonly occurredAt: Date;
  /** Provider payment id for captures/chargebacks, provider refund id for refunds. */
  readonly ref?: ProviderRef;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface SettlementBatch {
  readonly externalId: string;
  readonly currency: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly paidOutAt: Date | null;
}

export interface PaymentProviderAdapter {
  readonly key: ProviderKey;
  /** True when no real credentials were configured and the adapter answers from a local simulation. */
  readonly simulated?: boolean;
  capabilities(account: ProviderAccount): Capabilities;
  /** Sale (capture 'auto') or authorisation (capture 'manual'). */
  createPayment(req: PaymentRequest, idem: IdempotencyKey): Promise<ProviderResult>;
  capture(ref: ProviderRef, amount: Money, idem: IdempotencyKey): Promise<ProviderResult>;
  refund(ref: ProviderRef, amount: Money, idem: IdempotencyKey): Promise<ProviderResult>;
  reverse(ref: ProviderRef, idem: IdempotencyKey): Promise<ProviderResult>;
  /** Used to resolve the `uncertain` payment state before any retry. */
  getStatus(ref: ProviderRef): Promise<ProviderStatus>;
  verifyWebhook(
    headers: WebhookHeaders,
    rawBody: string | Buffer,
    secret: string,
  ): WebhookEvent | InvalidSignature;
  /** The settlement batch covering `period` (null when the provider has not settled it yet) and its lines. */
  settlementBatch(period: SettlementPeriod): Promise<SettlementBatch | null>;
  importSettlement(period: SettlementPeriod): AsyncIterable<SettlementLine>;
}

// --- terminals ------------------------------------------------------------

export interface TerminalInfo {
  readonly id: string;
  readonly provider: ProviderKey;
  readonly serialNumber: string;
  readonly connectionMode: ConnectionMode;
  readonly address?: string | null;
  /** Provider-side terminal id after pairing. */
  readonly pairingRef?: string | null;
}

export type PairingResult =
  | {
      readonly outcome: 'paired';
      readonly pairingRef: string;
      readonly model?: string;
      readonly firmware?: string;
    }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface TerminalSession {
  readonly terminal: TerminalInfo;
  readonly sessionId: string;
}

export interface TerminalRequest {
  readonly intentId: string;
  readonly amount: Money;
  readonly tip?: Money;
  readonly capture: 'auto' | 'manual';
  readonly reference: string;
  /** Allow the terminal to approve offline (only when capabilities.offlineModes[mode] permits and tenant caps allow). */
  readonly allowOffline: boolean;
}

export type TerminalEvent =
  | { readonly kind: 'display'; readonly message: string }
  | { readonly kind: 'card_presented'; readonly entryMode: NonNullable<MaskedCard['entryMode']> }
  | { readonly kind: 'authorizing' }
  | {
      readonly kind: 'result';
      readonly result: ProviderResult;
      /** True when the terminal approved without reaching the provider (store-and-forward). */
      readonly offline: boolean;
      readonly receiptText?: string;
    }
  | { readonly kind: 'cancelled' };

export interface TerminalHealth {
  readonly online: boolean;
  readonly lastSeenAt: Date | null;
  readonly firmware?: string;
  readonly batteryPercent?: number;
  /** Offline queue counters the Payments Edge enforces caps against (docs/01 §8.3). */
  readonly offlineQueued: { readonly count: number; readonly sumMinor: bigint };
}

export interface TerminalAdapter {
  pair(terminal: TerminalInfo, code: string): Promise<PairingResult>;
  startTransaction(session: TerminalSession, req: TerminalRequest): AsyncIterable<TerminalEvent>;
  cancel(session: TerminalSession): Promise<void>;
  /** Crash recovery: what did the terminal last do? */
  lastTransactionResult(terminal: TerminalInfo): Promise<ProviderStatus>;
  health(terminal: TerminalInfo): Promise<TerminalHealth>;
}
