import {
  bigint,
  boolean,
  char,
  customType,
  integer,
  jsonb,
  pgSchema,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of db/schema_part3.sql (payments schema). Identifiers + row types only; SQL stays
 * explicit in the payments module. The schema diff-check (schema-check.ts) proves this file matches
 * the migrated database column for column. Card data is limited to scheme-permitted masked fields:
 * a unit test in apps/api scans these column names for PAN/CVV/track/expiry patterns.
 */
export const paymentsSchema = pgSchema('payments');

/** char(3)[]: information_schema reports the element type as bpchar, so the mirror says so too. */
const char3Array = customType<{ data: string[]; driverData: string[] }>({
  dataType: () => 'bpchar[]',
});

const minor = (name: string) => bigint(name, { mode: 'bigint' });
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const paymentProviderAccounts = paymentsSchema.table('payment_provider_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  provider: text('provider').notNull(),
  name: text('name').notNull(),
  scopeKind: text('scope_kind').notNull().default('tenant'),
  scopeId: uuid('scope_id'),
  merchantRef: text('merchant_ref'),
  credentialsRef: text('credentials_ref').notNull(),
  settings: jsonb('settings').notNull().default({}),
  capabilities: jsonb('capabilities').notNull().default({}),
  currencies: char3Array('currencies').notNull().default([]),
  status: text('status').notNull().default('active'),
  health: jsonb('health').notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const paymentTerminals = paymentsSchema.table('payment_terminals', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  locationId: uuid('location_id').notNull(),
  providerAccountId: uuid('provider_account_id').notNull(),
  serialNumber: text('serial_number').notNull(),
  model: text('model'),
  pairingRef: text('pairing_ref'),
  connectionMode: text('connection_mode').notNull(),
  address: text('address'),
  assignedRegisterId: uuid('assigned_register_id'),
  status: text('status').notNull().default('unpaired'),
  lastSeenAt: ts('last_seen_at'),
  firmware: text('firmware'),
});

export const paymentIntents = paymentsSchema.table('payment_intents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  locationId: uuid('location_id').notNull(),
  orderId: uuid('order_id').notNull(),
  checkId: uuid('check_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  method: text('method').notNull(),
  amountMinor: minor('amount_minor').notNull(),
  tipMinor: minor('tip_minor').notNull().default(0n),
  surchargeMinor: minor('surcharge_minor').notNull().default(0n),
  cashbackMinor: minor('cashback_minor').notNull().default(0n),
  currency: char('currency', { length: 3 }).notNull(),
  status: text('status').notNull().default('created'),
  settlementStatus: text('settlement_status').notNull().default('unsettled'),
  providerAccountId: uuid('provider_account_id'),
  terminalId: uuid('terminal_id'),
  providerReference: text('provider_reference'),
  authorizedMinor: minor('authorized_minor').notNull().default(0n),
  capturedMinor: minor('captured_minor').notNull().default(0n),
  refundedMinor: minor('refunded_minor').notNull().default(0n),
  offline: boolean('offline').notNull().default(false),
  settlementPending: boolean('settlement_pending').notNull().default(false),
  offlineCollectedAt: ts('offline_collected_at'),
  offlineExpiresAt: ts('offline_expires_at'),
  offlineDeviceSeq: integer('offline_device_seq'),
  forwardedAt: ts('forwarded_at'),
  forwardOutcome: text('forward_outcome'),
  giftCardId: uuid('gift_card_id'),
  customerId: uuid('customer_id'),
  deviceId: uuid('device_id'),
  createdBy: uuid('created_by'),
  lastError: jsonb('last_error'),
  expiresAt: ts('expires_at'),
  version: integer('version').notNull().default(1),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const paymentAttempts = paymentsSchema.table('payment_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  intentId: uuid('intent_id').notNull(),
  attemptNo: smallint('attempt_no').notNull(),
  operation: text('operation').notNull(),
  providerRequestId: text('provider_request_id'),
  providerIdempotencyKey: text('provider_idempotency_key'),
  status: text('status').notNull(),
  requestRedacted: jsonb('request_redacted'),
  responseRedacted: jsonb('response_redacted'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  startedAt: ts('started_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
});

/** Partitioned by occurred_at; append-only (trigger). */
export const paymentEvents = paymentsSchema.table('payment_events', {
  id: uuid('id').notNull().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  intentId: uuid('intent_id').notNull(),
  attemptId: uuid('attempt_id'),
  kind: text('kind').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status'),
  source: text('source').notNull(),
  amountMinor: minor('amount_minor'),
  payload: jsonb('payload').notNull().default({}),
  actorUserId: uuid('actor_user_id'),
  deviceId: uuid('device_id'),
  occurredAt: ts('occurred_at').notNull(),
  recordedAt: ts('recorded_at').notNull().defaultNow(),
});

export const refunds = paymentsSchema.table('refunds', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  intentId: uuid('intent_id').notNull(),
  orderId: uuid('order_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  amountMinor: minor('amount_minor').notNull(),
  reason: text('reason'),
  method: text('method').notNull(),
  status: text('status').notNull().default('pending'),
  providerReference: text('provider_reference'),
  approvalId: uuid('approval_id'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
});

export const cardPaymentDetails = paymentsSchema.table('card_payment_details', {
  intentId: uuid('intent_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  cardBrand: text('card_brand'),
  last4: char('last4', { length: 4 }),
  entryMode: text('entry_mode'),
  authCode: text('auth_code'),
  aid: text('aid'),
  applicationLabel: text('application_label'),
  tokenRef: text('token_ref'),
  schemeReference: text('scheme_reference'),
  cardholderVerification: text('cardholder_verification'),
  issuerBank: text('issuer_bank'),
  terminalReceiptText: text('terminal_receipt_text'),
  receiptFields: jsonb('receipt_fields').notNull().default({}),
});

export const webhookInbox = paymentsSchema.table('webhook_inbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id'),
  provider: text('provider').notNull(),
  providerAccountId: uuid('provider_account_id'),
  externalEventId: text('external_event_id').notNull(),
  eventType: text('event_type'),
  signatureValid: boolean('signature_valid').notNull(),
  receivedAt: ts('received_at').notNull().defaultNow(),
  processedAt: ts('processed_at'),
  status: text('status').notNull().default('received'),
  attempts: smallint('attempts').notNull().default(0),
  error: text('error'),
  payload: jsonb('payload').notNull(),
});

export const settlements = paymentsSchema.table('settlements', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  providerAccountId: uuid('provider_account_id').notNull(),
  externalId: text('external_id').notNull(),
  periodStart: ts('period_start').notNull(),
  periodEnd: ts('period_end').notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  grossMinor: minor('gross_minor').notNull(),
  feesMinor: minor('fees_minor').notNull(),
  refundsMinor: minor('refunds_minor').notNull().default(0n),
  chargebacksMinor: minor('chargebacks_minor').notNull().default(0n),
  netMinor: minor('net_minor').notNull(),
  paidOutAt: ts('paid_out_at'),
  status: text('status').notNull().default('imported'),
  importedAt: ts('imported_at').notNull().defaultNow(),
});

export const settlementLines = paymentsSchema.table('settlement_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  settlementId: uuid('settlement_id').notNull(),
  intentId: uuid('intent_id'),
  refundId: uuid('refund_id'),
  externalRef: text('external_ref').notNull(),
  kind: text('kind').notNull(),
  amountMinor: minor('amount_minor').notNull(),
  feeMinor: minor('fee_minor').notNull().default(0n),
  occurredAt: ts('occurred_at'),
  matched: boolean('matched').notNull().default(false),
});

export const reconciliationExceptions = paymentsSchema.table('reconciliation_exceptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  domain: text('domain').notNull(),
  kind: text('kind').notNull(),
  severity: text('severity').notNull().default('medium'),
  subjectKind: text('subject_kind'),
  subjectId: uuid('subject_id'),
  details: jsonb('details').notNull(),
  status: text('status').notNull().default('open'),
  resolvedBy: uuid('resolved_by'),
  resolvedAt: ts('resolved_at'),
  resolutionNote: text('resolution_note'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const disputes = paymentsSchema.table('disputes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  intentId: uuid('intent_id').notNull(),
  providerReference: text('provider_reference').notNull(),
  amountMinor: minor('amount_minor').notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  reasonCode: text('reason_code'),
  status: text('status').notNull(),
  evidenceDueAt: ts('evidence_due_at'),
  openedAt: ts('opened_at').notNull(),
  closedAt: ts('closed_at'),
});
