/**
 * Payments DTOs for Phase 1 F5 (docs/03-implementation-plan.md §5 F5, docs/01 §7.3/§7.4/§8.3).
 * Enum values mirror the CHECK constraints in db/schema_part3.sql (payments schema). Money travels
 * as integer strings in minor units. NOTHING here may carry PAN, CVV, track data or expiry: card
 * data is limited to the masked, scheme-permitted receipt fields of `CardPaymentDetailsSchema`
 * (a unit test in apps/api scans this file's JSON Schemas for forbidden field names).
 */
import { z } from 'zod';

import { CursorQuerySchema, MinorAmountSchema, isoInstant, pageOf, uuid } from './common.js';
import { CurrencyCodeSchema } from './tenancy.js';

const positiveMinor = MinorAmountSchema.refine((v) => BigInt(v) > 0n, 'must be greater than zero');
const nonNegativeMinor = MinorAmountSchema.refine((v) => BigInt(v) >= 0n, 'must not be negative');
const clientKey = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,128}$/, '8-128 URL-safe characters')
  .describe('Client-generated idempotency key; with the tenant it identifies the operation.');

// ---------------------------------------------------------------------------
// Permissions and events owned by this slice
// ---------------------------------------------------------------------------

/**
 * Permission keys the payments routes check. They are NOT in the @pos/auth catalog yet (that
 * package belongs to the integration lead): see docs/releases/s-f5.md. Refunds use the existing
 * `orders.refund.create` key and its `orders.refund.max_minor` limit.
 */
export const PAYMENT_PERMISSIONS = {
  view: 'payments.view',
  take: 'payments.intent.create',
  manage: 'payments.intent.manage',
  providerManage: 'payments.provider.manage',
  terminalManage: 'payments.terminal.manage',
  settlementManage: 'payments.settlement.manage',
  reconcile: 'payments.reconcile.manage',
} as const;

/** Domain events emitted through the outbox. `refund.succeeded` must be added to EVENT_CATALOG by the integration lead. */
export const PAYMENT_EVENTS = [
  'payment.authorized',
  'payment.captured',
  'payment.failed',
  'refund.succeeded',
] as const;
export type PaymentEventName = (typeof PAYMENT_EVENTS)[number];

// ---------------------------------------------------------------------------
// Enums (db/schema_part3.sql CHECK constraints)
// ---------------------------------------------------------------------------

export const PAYMENT_PROVIDERS = [
  'stripe',
  'adyen',
  'tyro',
  'windcave',
  'linkly',
  'square',
  'manual',
  'mock',
] as const;
export const PaymentProviderSchema = z.enum(PAYMENT_PROVIDERS);

export const PAYMENT_METHODS = [
  'cash',
  'card_present',
  'card_not_present',
  'wallet',
  'qr',
  'gift_card',
  'store_credit',
  'loyalty',
  'bank_transfer',
  'bnpl',
  'external',
  'deposit_applied',
] as const;
export const PaymentMethodSchema = z.enum(PAYMENT_METHODS);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

export const PAYMENT_INTENT_STATUSES = [
  'created',
  'processing',
  'authorized',
  'captured',
  'partially_refunded',
  'refunded',
  'reversed',
  'failed',
  'cancelled',
  'uncertain',
] as const;
export const PaymentIntentStatusSchema = z.enum(PAYMENT_INTENT_STATUSES);
export type PaymentIntentStatus = z.infer<typeof PaymentIntentStatusSchema>;

export const SETTLEMENT_STATUSES = ['unsettled', 'settled', 'disputed', 'not_applicable'] as const;
export const SettlementStatusSchema = z.enum(SETTLEMENT_STATUSES);

export const FORWARD_OUTCOMES = [
  'pending',
  'approved',
  'declined',
  'expired',
  'rescue_in_progress',
] as const;
export const ForwardOutcomeSchema = z.enum(FORWARD_OUTCOMES);
export type ForwardOutcome = z.infer<typeof ForwardOutcomeSchema>;

export const PAYMENT_ATTEMPT_OPERATIONS = [
  'sale',
  'auth',
  'capture',
  'refund',
  'reverse',
  'status_query',
  'cancel',
] as const;
export const PAYMENT_ATTEMPT_STATUSES = [
  'started',
  'succeeded',
  'declined',
  'error',
  'timeout',
] as const;
export const PAYMENT_EVENT_SOURCES = [
  'pos',
  'api',
  'provider_webhook',
  'terminal',
  'reconciliation',
  'admin',
  'system',
] as const;
export const REFUND_STATUSES = [
  'pending',
  'processing',
  'succeeded',
  'failed',
  'uncertain',
  'cancelled',
] as const;
export const REFUND_METHODS = ['original', 'cash', 'store_credit', 'gift_card'] as const;
export const TERMINAL_CONNECTION_MODES = ['cloud', 'lan', 'sdk'] as const;
export const TERMINAL_STATUSES = ['unpaired', 'paired', 'offline', 'faulty', 'retired'] as const;
export const PROVIDER_ACCOUNT_STATUSES = ['pending', 'active', 'disabled'] as const;
export const WEBHOOK_INBOX_STATUSES = [
  'received',
  'processed',
  'ignored',
  'failed',
  'invalid_signature',
] as const;
export const SETTLEMENT_RUN_STATUSES = [
  'imported',
  'reconciling',
  'reconciled',
  'exceptions',
] as const;
export const SETTLEMENT_LINE_KINDS = [
  'capture',
  'refund',
  'chargeback',
  'fee',
  'adjustment',
] as const;
export const EXCEPTION_STATUSES = ['open', 'investigating', 'resolved', 'accepted'] as const;
export const EXCEPTION_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
/** Payment-domain subset of reconciliation_exceptions.kind. */
export const PAYMENT_EXCEPTION_KINDS = [
  'missing_in_settlement',
  'missing_in_platform',
  'amount_mismatch',
  'fee_mismatch',
  'duplicate_capture_suspected',
  'uncertain_aged',
  'offline_declined',
  'offline_expired',
  'offline_cap_exceeded',
] as const;

// ---------------------------------------------------------------------------
// Provider capabilities (payment_provider_accounts.capabilities jsonb)
// ---------------------------------------------------------------------------

export const OfflineModeSchema = z.enum(['local_terminal_api', 'sdk', 'none']);

/** docs/01 §7.4 amended shape: offline support is per terminal connection mode, not per provider. */
export const ProviderCapabilitiesSchema = z.object({
  cardPresent: z.boolean(),
  cardNotPresent: z.boolean(),
  preAuth: z.boolean(),
  tipAdjust: z.boolean(),
  offlineStoreAndForward: z.boolean(),
  offlineModes: z.object({
    cloud: OfflineModeSchema,
    lan: OfflineModeSchema,
    sdk: OfflineModeSchema,
  }),
  offlineExcludedSchemes: z.array(z.string().max(32)).max(50),
  leastCostRouting: z.boolean(),
  refundsWithoutOriginal: z.boolean(),
  surcharging: z.boolean(),
  certificationStatus: z.enum(['certified', 'in_progress', 'not_required', 'not_started']),
  currencies: z.array(CurrencyCodeSchema).max(200),
});
export type ProviderCapabilitiesDto = z.infer<typeof ProviderCapabilitiesSchema>;

/** payment_provider_accounts.settings: offline floor limits and caps, capture mode, surcharge rules. */
export const ProviderAccountSettingsSchema = z
  .object({
    captureMode: z.enum(['auto', 'manual']),
    offline: z
      .object({
        enabled: z.boolean(),
        /** Window after which a stored payment can no longer be forwarded (24 h, 72 h, 7 d …). */
        windowHours: z
          .number()
          .int()
          .min(1)
          .max(24 * 31),
        maxTransactionMinor: nonNegativeMinor,
        maxCountPerDevice: z.number().int().min(0).max(10_000),
        maxSumPerDeviceMinor: nonNegativeMinor,
      })
      .partial(),
    uncertainEscalateAfterSeconds: z.number().int().min(10).max(86_400),
  })
  .partial();
export type ProviderAccountSettings = z.infer<typeof ProviderAccountSettingsSchema>;

// ---------------------------------------------------------------------------
// Provider accounts and terminals
// ---------------------------------------------------------------------------

export const ProviderAccountSchema = z.object({
  id: uuid,
  tenantId: uuid,
  provider: PaymentProviderSchema,
  name: z.string(),
  scopeKind: z.enum(['tenant', 'org_unit', 'location']),
  scopeId: uuid.nullable(),
  merchantRef: z.string().nullable(),
  /** Reference into the secret store. Never the secret itself. */
  credentialsRef: z.string(),
  settings: ProviderAccountSettingsSchema,
  capabilities: ProviderCapabilitiesSchema.partial(),
  currencies: z.array(CurrencyCodeSchema),
  status: z.enum(PROVIDER_ACCOUNT_STATUSES),
  /** True when the adapter answers from a local simulation (no real credentials configured). */
  simulated: z.boolean(),
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
export type ProviderAccountDto = z.infer<typeof ProviderAccountSchema>;

export const CreateProviderAccountSchema = z.object({
  provider: PaymentProviderSchema,
  name: z.string().min(1).max(200),
  scopeKind: z.enum(['tenant', 'org_unit', 'location']).default('tenant'),
  scopeId: uuid.nullable().optional(),
  merchantRef: z.string().max(200).optional(),
  credentialsRef: z
    .string()
    .min(1)
    .max(300)
    .regex(/^[A-Za-z0-9][A-Za-z0-9/_.:@-]*$/, 'a secret-store key, not a secret value'),
  settings: ProviderAccountSettingsSchema.optional(),
  currencies: z.array(CurrencyCodeSchema).min(1).max(20).default(['AUD']),
  status: z.enum(PROVIDER_ACCOUNT_STATUSES).default('active'),
});
export type CreateProviderAccount = z.infer<typeof CreateProviderAccountSchema>;

export const UpdateProviderAccountSchema = z
  .object({
    name: z.string().min(1).max(200),
    merchantRef: z.string().max(200).nullable(),
    credentialsRef: CreateProviderAccountSchema.shape.credentialsRef,
    settings: ProviderAccountSettingsSchema,
    currencies: z.array(CurrencyCodeSchema).min(1).max(20),
    status: z.enum(PROVIDER_ACCOUNT_STATUSES),
  })
  .partial();
export type UpdateProviderAccount = z.infer<typeof UpdateProviderAccountSchema>;

export const PaymentTerminalSchema = z.object({
  id: uuid,
  tenantId: uuid,
  locationId: uuid,
  providerAccountId: uuid,
  serialNumber: z.string(),
  model: z.string().nullable(),
  pairingRef: z.string().nullable(),
  connectionMode: z.enum(TERMINAL_CONNECTION_MODES),
  address: z.string().nullable(),
  assignedRegisterId: uuid.nullable(),
  status: z.enum(TERMINAL_STATUSES),
  lastSeenAt: isoInstant.nullable(),
  firmware: z.string().nullable(),
  /** Whether this terminal's connection mode permits offline card approval for its provider account. */
  offlineCapable: z.boolean(),
});
export type PaymentTerminalDto = z.infer<typeof PaymentTerminalSchema>;

export const CreateTerminalSchema = z.object({
  locationId: uuid,
  providerAccountId: uuid,
  serialNumber: z.string().min(1).max(100),
  model: z.string().max(100).optional(),
  connectionMode: z.enum(TERMINAL_CONNECTION_MODES),
  address: z.string().max(255).optional(),
  assignedRegisterId: uuid.nullable().optional(),
});
export type CreateTerminal = z.infer<typeof CreateTerminalSchema>;

export const UpdateTerminalSchema = z
  .object({
    address: z.string().max(255).nullable(),
    assignedRegisterId: uuid.nullable(),
    status: z.enum(['offline', 'faulty', 'retired']),
  })
  .partial();
export type UpdateTerminal = z.infer<typeof UpdateTerminalSchema>;

export const PairTerminalSchema = z.object({ code: z.string().min(4).max(32) });

// ---------------------------------------------------------------------------
// Intents, attempts, events, card details
// ---------------------------------------------------------------------------

/** Scheme-permitted receipt data only (payments.card_payment_details). No PAN, CVV, track data or expiry. */
export const CardPaymentDetailsSchema = z.object({
  intentId: uuid,
  cardBrand: z.string().nullable(),
  last4: z
    .string()
    .regex(/^\d{4}$/)
    .nullable(),
  entryMode: z.string().nullable(),
  authCode: z.string().nullable(),
  aid: z.string().nullable(),
  applicationLabel: z.string().nullable(),
  tokenRef: z.string().nullable(),
  schemeReference: z.string().nullable(),
  cardholderVerification: z.string().nullable(),
  issuerBank: z.string().nullable(),
  terminalReceiptText: z.string().nullable(),
});
export type CardPaymentDetailsDto = z.infer<typeof CardPaymentDetailsSchema>;

export const PaymentIntentSchema = z.object({
  id: uuid,
  tenantId: uuid,
  locationId: uuid,
  orderId: uuid,
  checkId: uuid,
  idempotencyKey: z.string(),
  method: PaymentMethodSchema,
  amountMinor: MinorAmountSchema,
  tipMinor: MinorAmountSchema,
  surchargeMinor: MinorAmountSchema,
  cashbackMinor: MinorAmountSchema,
  currency: CurrencyCodeSchema,
  status: PaymentIntentStatusSchema,
  settlementStatus: SettlementStatusSchema,
  providerAccountId: uuid.nullable(),
  terminalId: uuid.nullable(),
  providerReference: z.string().nullable(),
  authorizedMinor: MinorAmountSchema,
  capturedMinor: MinorAmountSchema,
  refundedMinor: MinorAmountSchema,
  offline: z.boolean(),
  settlementPending: z.boolean(),
  offlineCollectedAt: isoInstant.nullable(),
  offlineExpiresAt: isoInstant.nullable(),
  offlineDeviceSeq: z.number().int().nullable(),
  forwardedAt: isoInstant.nullable(),
  forwardOutcome: ForwardOutcomeSchema.nullable(),
  deviceId: uuid.nullable(),
  lastError: z.record(z.string(), z.unknown()).nullable(),
  version: z.number().int().positive(),
  createdAt: isoInstant,
  updatedAt: isoInstant,
  card: CardPaymentDetailsSchema.nullable(),
});
export type PaymentIntentDto = z.infer<typeof PaymentIntentSchema>;

export const CreatePaymentIntentSchema = z.object({
  locationId: uuid,
  orderId: uuid,
  checkId: uuid,
  clientIntentId: clientKey,
  method: PaymentMethodSchema.exclude(['cash']),
  amountMinor: positiveMinor,
  tipMinor: nonNegativeMinor.optional(),
  surchargeMinor: nonNegativeMinor.optional(),
  providerAccountId: uuid.optional(),
  terminalId: uuid.optional(),
  deviceId: uuid.optional(),
});
export type CreatePaymentIntent = z.infer<typeof CreatePaymentIntentSchema>;

export const PaymentIntentListQuerySchema = CursorQuerySchema.extend({
  orderId: uuid.optional(),
  checkId: uuid.optional(),
  locationId: uuid.optional(),
  status: PaymentIntentStatusSchema.optional(),
  /** 'true' lists offline sales whose forward outcome is still open. */
  offlineOpen: z.enum(['true', 'false']).optional(),
});
export type PaymentIntentListQuery = z.infer<typeof PaymentIntentListQuerySchema>;
export const PaymentIntentPageSchema = pageOf(PaymentIntentSchema);

export const SubmitIntentSchema = z.object({
  /** Allow the terminal to approve offline when its connection mode and the tenant caps permit. */
  allowOffline: z.boolean().optional(),
});
export type SubmitIntent = z.infer<typeof SubmitIntentSchema>;

export const CaptureIntentSchema = z.object({
  amountMinor: positiveMinor.optional(),
  tipMinor: nonNegativeMinor.optional(),
});
export type CaptureIntent = z.infer<typeof CaptureIntentSchema>;

export const CancelIntentSchema = z.object({ reason: z.string().max(500).optional() });
export const ReverseIntentSchema = z.object({ reason: z.string().max(500).optional() });

export const PaymentAttemptSchema = z.object({
  id: uuid,
  intentId: uuid,
  attemptNo: z.number().int(),
  operation: z.enum(PAYMENT_ATTEMPT_OPERATIONS),
  providerRequestId: z.string().nullable(),
  providerIdempotencyKey: z.string().nullable(),
  status: z.enum(PAYMENT_ATTEMPT_STATUSES),
  requestRedacted: z.unknown().nullable(),
  responseRedacted: z.unknown().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: isoInstant,
  finishedAt: isoInstant.nullable(),
});
export type PaymentAttemptDto = z.infer<typeof PaymentAttemptSchema>;

export const PaymentEventSchema = z.object({
  id: uuid,
  intentId: uuid,
  attemptId: uuid.nullable(),
  kind: z.string(),
  fromStatus: PaymentIntentStatusSchema.nullable(),
  toStatus: PaymentIntentStatusSchema.nullable(),
  source: z.enum(PAYMENT_EVENT_SOURCES),
  amountMinor: MinorAmountSchema.nullable(),
  payload: z.record(z.string(), z.unknown()),
  actorUserId: uuid.nullable(),
  deviceId: uuid.nullable(),
  occurredAt: isoInstant,
  recordedAt: isoInstant,
});
export type PaymentEventDto = z.infer<typeof PaymentEventSchema>;

// ---------------------------------------------------------------------------
// Cash tender (AUD 5c rounding recorded on the intent event and the order)
// ---------------------------------------------------------------------------

export const CashTenderSchema = z.object({
  locationId: uuid,
  orderId: uuid,
  checkId: uuid,
  clientIntentId: clientKey,
  /** Amount of the check to settle with cash; defaults to the outstanding balance. */
  amountMinor: positiveMinor.optional(),
  /** Cash handed over; defaults to exactly what is due. */
  tenderedMinor: positiveMinor.optional(),
  deviceId: uuid.optional(),
});
export type CashTender = z.infer<typeof CashTenderSchema>;

export const CashTenderResultSchema = z.object({
  intent: PaymentIntentSchema,
  /** What the customer owes in cash after currency rounding. */
  dueMinor: MinorAmountSchema,
  tenderedMinor: MinorAmountSchema,
  changeMinor: MinorAmountSchema,
  /** roundedDue - outstanding; recorded as rounding_minor on the order and check. */
  roundingMinor: z.string().regex(/^-?\d+$/),
});
export type CashTenderResultDto = z.infer<typeof CashTenderResultSchema>;

// ---------------------------------------------------------------------------
// Offline (store-and-forward) lifecycle, docs/01 §8.3
// ---------------------------------------------------------------------------

export const OfflineCollectionSchema = z.object({
  locationId: uuid,
  orderId: uuid,
  checkId: uuid,
  clientIntentId: clientKey,
  providerAccountId: uuid,
  terminalId: uuid,
  deviceId: uuid.optional(),
  amountMinor: positiveMinor,
  tipMinor: nonNegativeMinor.optional(),
  /** Position in the device's offline queue (caps are enforced at the Payments Edge, proven nightly). */
  deviceSeq: z.number().int().min(0).optional(),
  collectedAt: isoInstant,
  /** Provider/tenant window end; defaults to collectedAt + the account's offline window. */
  expiresAt: isoInstant.optional(),
  card: z
    .object({
      cardBrand: z.string().max(32).optional(),
      last4: z
        .string()
        .regex(/^\d{4}$/)
        .optional(),
      entryMode: z.string().max(32).optional(),
      authCode: z.string().max(32).optional(),
      aid: z.string().max(64).optional(),
      applicationLabel: z.string().max(64).optional(),
      terminalReceiptText: z.string().max(4000).optional(),
    })
    .optional(),
});
export type OfflineCollection = z.infer<typeof OfflineCollectionSchema>;

export const ForwardOutcomeRequestSchema = z.object({
  outcome: z.enum(['approved', 'declined', 'rescue_in_progress']),
  forwardedAt: isoInstant.optional(),
  providerReference: z.string().max(200).optional(),
  declineCode: z.string().max(100).optional(),
  /** Extend the window while the provider retries (Adyen Auto Rescue). */
  expiresAt: isoInstant.optional(),
});
export type ForwardOutcomeRequest = z.infer<typeof ForwardOutcomeRequestSchema>;

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

export const RefundSchema = z.object({
  id: uuid,
  tenantId: uuid,
  intentId: uuid,
  orderId: uuid,
  idempotencyKey: z.string(),
  amountMinor: MinorAmountSchema,
  reason: z.string().nullable(),
  method: z.enum(REFUND_METHODS),
  status: z.enum(REFUND_STATUSES),
  providerReference: z.string().nullable(),
  approvalId: uuid.nullable(),
  createdBy: uuid.nullable(),
  createdAt: isoInstant,
  finishedAt: isoInstant.nullable(),
});
export type RefundDto = z.infer<typeof RefundSchema>;

export const CreateRefundSchema = z.object({
  /** The return/refund order the refund belongs to (refunds.order_id). */
  orderId: uuid,
  clientRefundId: clientKey,
  amountMinor: positiveMinor,
  reason: z.string().max(500).optional(),
  method: z.enum(REFUND_METHODS).default('original'),
  approvalId: uuid.optional(),
});
export type CreateRefund = z.infer<typeof CreateRefundSchema>;

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export const WebhookParamsSchema = z.object({
  provider: PaymentProviderSchema,
  tenantId: uuid,
  accountId: uuid,
});

export const WebhookReceiptSchema = z.object({
  status: z.enum(['processed', 'ignored', 'duplicate', 'failed']),
  inboxId: uuid.nullable(),
});
export type WebhookReceiptDto = z.infer<typeof WebhookReceiptSchema>;

export const WebhookInboxEntrySchema = z.object({
  id: uuid,
  provider: z.string(),
  providerAccountId: uuid.nullable(),
  externalEventId: z.string(),
  eventType: z.string().nullable(),
  signatureValid: z.boolean(),
  receivedAt: isoInstant,
  processedAt: isoInstant.nullable(),
  status: z.enum(WEBHOOK_INBOX_STATUSES),
  attempts: z.number().int(),
  error: z.string().nullable(),
});
export type WebhookInboxEntryDto = z.infer<typeof WebhookInboxEntrySchema>;
export const WebhookInboxQuerySchema = CursorQuerySchema.extend({
  status: z.enum(WEBHOOK_INBOX_STATUSES).optional(),
});
export const WebhookInboxPageSchema = pageOf(WebhookInboxEntrySchema);

// ---------------------------------------------------------------------------
// Settlement and reconciliation
// ---------------------------------------------------------------------------

export const SettlementSchema = z.object({
  id: uuid,
  providerAccountId: uuid,
  externalId: z.string(),
  periodStart: isoInstant,
  periodEnd: isoInstant,
  currency: CurrencyCodeSchema,
  grossMinor: MinorAmountSchema,
  feesMinor: MinorAmountSchema,
  refundsMinor: MinorAmountSchema,
  chargebacksMinor: MinorAmountSchema,
  netMinor: MinorAmountSchema,
  paidOutAt: isoInstant.nullable(),
  status: z.enum(SETTLEMENT_RUN_STATUSES),
  importedAt: isoInstant,
  lineCount: z.number().int().optional(),
  unmatchedCount: z.number().int().optional(),
});
export type SettlementDto = z.infer<typeof SettlementSchema>;

export const SettlementLineSchema = z.object({
  id: uuid,
  settlementId: uuid,
  intentId: uuid.nullable(),
  refundId: uuid.nullable(),
  externalRef: z.string(),
  kind: z.enum(SETTLEMENT_LINE_KINDS),
  amountMinor: z.string().regex(/^-?\d+$/),
  feeMinor: MinorAmountSchema,
  occurredAt: isoInstant.nullable(),
  matched: z.boolean(),
});
export type SettlementLineDto = z.infer<typeof SettlementLineSchema>;

export const SettlementDetailSchema = SettlementSchema.extend({
  lines: z.array(SettlementLineSchema),
});

export const ImportSettlementSchema = z
  .object({
    providerAccountId: uuid,
    from: isoInstant,
    to: isoInstant,
  })
  .refine((v) => new Date(v.from) < new Date(v.to), { message: 'from must be before to' });
export type ImportSettlement = z.infer<typeof ImportSettlementSchema>;

export const ImportSettlementResultSchema = z.object({
  settlement: SettlementSchema.nullable(),
  /** True when this batch had already been imported (the import is idempotent). */
  alreadyImported: z.boolean(),
  exceptionsRaised: z.number().int(),
});

export const SettlementListQuerySchema = CursorQuerySchema.extend({
  providerAccountId: uuid.optional(),
});
export const SettlementPageSchema = pageOf(SettlementSchema);

export const ReconciliationExceptionSchema = z.object({
  id: uuid,
  tenantId: uuid,
  domain: z.string(),
  kind: z.string(),
  severity: z.enum(EXCEPTION_SEVERITIES),
  subjectKind: z.string().nullable(),
  subjectId: uuid.nullable(),
  details: z.record(z.string(), z.unknown()),
  status: z.enum(EXCEPTION_STATUSES),
  resolvedBy: uuid.nullable(),
  resolvedAt: isoInstant.nullable(),
  resolutionNote: z.string().nullable(),
  createdAt: isoInstant,
});
export type ReconciliationExceptionDto = z.infer<typeof ReconciliationExceptionSchema>;

export const ExceptionListQuerySchema = CursorQuerySchema.extend({
  status: z.enum(EXCEPTION_STATUSES).optional(),
  kind: z.enum(PAYMENT_EXCEPTION_KINDS).optional(),
});
export const ExceptionPageSchema = pageOf(ReconciliationExceptionSchema);

export const ResolveExceptionSchema = z.object({
  status: z.enum(['investigating', 'resolved', 'accepted']),
  note: z.string().max(1000).optional(),
});
export type ResolveException = z.infer<typeof ResolveExceptionSchema>;
