import type {
  CardPaymentDetailsDto,
  PaymentAttemptDto,
  PaymentEventDto,
  PaymentIntentDto,
  PaymentIntentStatus,
  ProviderAccountDto,
  ProviderCapabilitiesDto,
  PaymentTerminalDto,
  ReconciliationExceptionDto,
  RefundDto,
  SettlementDto,
  SettlementLineDto,
  WebhookInboxEntryDto,
  ProviderAccountSettings,
} from '@pos/contracts';

export const iso = (d: Date): string => d.toISOString();
export const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);
const minor = (v: bigint): string => v.toString();

export interface ProviderAccountRow {
  id: string;
  tenant_id: string;
  provider: ProviderAccountDto['provider'];
  name: string;
  scope_kind: ProviderAccountDto['scopeKind'];
  scope_id: string | null;
  merchant_ref: string | null;
  credentials_ref: string;
  settings: ProviderAccountSettings;
  capabilities: Partial<ProviderCapabilitiesDto>;
  currencies: string[];
  status: ProviderAccountDto['status'];
  created_at: Date;
  updated_at: Date;
}

export function toProviderAccountDto(
  r: ProviderAccountRow,
  simulated: boolean,
): ProviderAccountDto {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    provider: r.provider,
    name: r.name,
    scopeKind: r.scope_kind,
    scopeId: r.scope_id,
    merchantRef: r.merchant_ref,
    credentialsRef: r.credentials_ref,
    settings: r.settings ?? {},
    capabilities: r.capabilities ?? {},
    currencies: (r.currencies ?? []).map((c) => c.trim()),
    status: r.status,
    simulated,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export interface TerminalRow {
  id: string;
  tenant_id: string;
  location_id: string;
  provider_account_id: string;
  serial_number: string;
  model: string | null;
  pairing_ref: string | null;
  connection_mode: PaymentTerminalDto['connectionMode'];
  address: string | null;
  assigned_register_id: string | null;
  status: PaymentTerminalDto['status'];
  last_seen_at: Date | null;
  firmware: string | null;
}

export function toTerminalDto(r: TerminalRow, offlineCapable: boolean): PaymentTerminalDto {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    locationId: r.location_id,
    providerAccountId: r.provider_account_id,
    serialNumber: r.serial_number,
    model: r.model,
    pairingRef: r.pairing_ref,
    connectionMode: r.connection_mode,
    address: r.address,
    assignedRegisterId: r.assigned_register_id,
    status: r.status,
    lastSeenAt: isoOrNull(r.last_seen_at),
    firmware: r.firmware,
    offlineCapable,
  };
}

export interface IntentRow {
  id: string;
  tenant_id: string;
  location_id: string;
  order_id: string;
  check_id: string;
  idempotency_key: string;
  method: PaymentIntentDto['method'];
  amount_minor: bigint;
  tip_minor: bigint;
  surcharge_minor: bigint;
  cashback_minor: bigint;
  currency: string;
  status: PaymentIntentStatus;
  settlement_status: PaymentIntentDto['settlementStatus'];
  provider_account_id: string | null;
  terminal_id: string | null;
  provider_reference: string | null;
  authorized_minor: bigint;
  captured_minor: bigint;
  refunded_minor: bigint;
  offline: boolean;
  settlement_pending: boolean;
  offline_collected_at: Date | null;
  offline_expires_at: Date | null;
  offline_device_seq: number | null;
  forwarded_at: Date | null;
  forward_outcome: PaymentIntentDto['forwardOutcome'];
  device_id: string | null;
  created_by: string | null;
  last_error: Record<string, unknown> | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface CardRow {
  intent_id: string;
  tenant_id: string;
  card_brand: string | null;
  last4: string | null;
  entry_mode: string | null;
  auth_code: string | null;
  aid: string | null;
  application_label: string | null;
  token_ref: string | null;
  scheme_reference: string | null;
  cardholder_verification: string | null;
  issuer_bank: string | null;
  terminal_receipt_text: string | null;
}

export function toCardDto(r: CardRow): CardPaymentDetailsDto {
  return {
    intentId: r.intent_id,
    cardBrand: r.card_brand,
    last4: r.last4,
    entryMode: r.entry_mode,
    authCode: r.auth_code,
    aid: r.aid,
    applicationLabel: r.application_label,
    tokenRef: r.token_ref,
    schemeReference: r.scheme_reference,
    cardholderVerification: r.cardholder_verification,
    issuerBank: r.issuer_bank,
    terminalReceiptText: r.terminal_receipt_text,
  };
}

export function toIntentDto(r: IntentRow, card: CardRow | null | undefined): PaymentIntentDto {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    locationId: r.location_id,
    orderId: r.order_id,
    checkId: r.check_id,
    idempotencyKey: r.idempotency_key,
    method: r.method,
    amountMinor: minor(r.amount_minor),
    tipMinor: minor(r.tip_minor),
    surchargeMinor: minor(r.surcharge_minor),
    cashbackMinor: minor(r.cashback_minor),
    currency: r.currency.trim(),
    status: r.status,
    settlementStatus: r.settlement_status,
    providerAccountId: r.provider_account_id,
    terminalId: r.terminal_id,
    providerReference: r.provider_reference,
    authorizedMinor: minor(r.authorized_minor),
    capturedMinor: minor(r.captured_minor),
    refundedMinor: minor(r.refunded_minor),
    offline: r.offline,
    settlementPending: r.settlement_pending,
    offlineCollectedAt: isoOrNull(r.offline_collected_at),
    offlineExpiresAt: isoOrNull(r.offline_expires_at),
    offlineDeviceSeq: r.offline_device_seq,
    forwardedAt: isoOrNull(r.forwarded_at),
    forwardOutcome: r.forward_outcome,
    deviceId: r.device_id,
    lastError: r.last_error,
    version: r.version,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    card: card ? toCardDto(card) : null,
  };
}

/** Total the customer is charged by the provider for this intent: amount + tip + surcharge. */
export const chargeTotal = (r: IntentRow): bigint =>
  r.amount_minor + r.tip_minor + r.surcharge_minor;

export interface AttemptRow {
  id: string;
  intent_id: string;
  attempt_no: number;
  operation: PaymentAttemptDto['operation'];
  provider_request_id: string | null;
  provider_idempotency_key: string | null;
  status: PaymentAttemptDto['status'];
  request_redacted: unknown;
  response_redacted: unknown;
  error_code: string | null;
  error_message: string | null;
  started_at: Date;
  finished_at: Date | null;
}

export function toAttemptDto(r: AttemptRow): PaymentAttemptDto {
  return {
    id: r.id,
    intentId: r.intent_id,
    attemptNo: r.attempt_no,
    operation: r.operation,
    providerRequestId: r.provider_request_id,
    providerIdempotencyKey: r.provider_idempotency_key,
    status: r.status,
    requestRedacted: r.request_redacted ?? null,
    responseRedacted: r.response_redacted ?? null,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    startedAt: iso(r.started_at),
    finishedAt: isoOrNull(r.finished_at),
  };
}

export interface EventRow {
  id: string;
  intent_id: string;
  attempt_id: string | null;
  kind: string;
  from_status: PaymentIntentStatus | null;
  to_status: PaymentIntentStatus | null;
  source: PaymentEventDto['source'];
  amount_minor: bigint | null;
  payload: Record<string, unknown>;
  actor_user_id: string | null;
  device_id: string | null;
  occurred_at: Date;
  recorded_at: Date;
}

export function toEventDto(r: EventRow): PaymentEventDto {
  return {
    id: r.id,
    intentId: r.intent_id,
    attemptId: r.attempt_id,
    kind: r.kind,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    source: r.source,
    amountMinor: r.amount_minor === null ? null : minor(r.amount_minor),
    payload: r.payload,
    actorUserId: r.actor_user_id,
    deviceId: r.device_id,
    occurredAt: iso(r.occurred_at),
    recordedAt: iso(r.recorded_at),
  };
}

export interface RefundRow {
  id: string;
  tenant_id: string;
  intent_id: string;
  order_id: string;
  idempotency_key: string;
  amount_minor: bigint;
  reason: string | null;
  method: RefundDto['method'];
  status: RefundDto['status'];
  provider_reference: string | null;
  approval_id: string | null;
  created_by: string | null;
  created_at: Date;
  finished_at: Date | null;
}

export function toRefundDto(r: RefundRow): RefundDto {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    intentId: r.intent_id,
    orderId: r.order_id,
    idempotencyKey: r.idempotency_key,
    amountMinor: minor(r.amount_minor),
    reason: r.reason,
    method: r.method,
    status: r.status,
    providerReference: r.provider_reference,
    approvalId: r.approval_id,
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    finishedAt: isoOrNull(r.finished_at),
  };
}

export interface WebhookInboxRow {
  id: string;
  tenant_id: string | null;
  provider: string;
  provider_account_id: string | null;
  external_event_id: string;
  event_type: string | null;
  signature_valid: boolean;
  received_at: Date;
  processed_at: Date | null;
  status: WebhookInboxEntryDto['status'];
  attempts: number;
  error: string | null;
}

export function toWebhookInboxDto(r: WebhookInboxRow): WebhookInboxEntryDto {
  return {
    id: r.id,
    provider: r.provider,
    providerAccountId: r.provider_account_id,
    externalEventId: r.external_event_id,
    eventType: r.event_type,
    signatureValid: r.signature_valid,
    receivedAt: iso(r.received_at),
    processedAt: isoOrNull(r.processed_at),
    status: r.status,
    attempts: r.attempts,
    error: r.error,
  };
}

export interface SettlementRow {
  id: string;
  tenant_id: string;
  provider_account_id: string;
  external_id: string;
  period_start: Date;
  period_end: Date;
  currency: string;
  gross_minor: bigint;
  fees_minor: bigint;
  refunds_minor: bigint;
  chargebacks_minor: bigint;
  net_minor: bigint;
  paid_out_at: Date | null;
  status: SettlementDto['status'];
  imported_at: Date;
  line_count?: string | number | bigint;
  unmatched_count?: string | number | bigint;
}

export function toSettlementDto(r: SettlementRow): SettlementDto {
  return {
    id: r.id,
    providerAccountId: r.provider_account_id,
    externalId: r.external_id,
    periodStart: iso(r.period_start),
    periodEnd: iso(r.period_end),
    currency: r.currency.trim(),
    grossMinor: minor(r.gross_minor),
    feesMinor: minor(r.fees_minor),
    refundsMinor: minor(r.refunds_minor),
    chargebacksMinor: minor(r.chargebacks_minor),
    netMinor: minor(r.net_minor),
    paidOutAt: isoOrNull(r.paid_out_at),
    status: r.status,
    importedAt: iso(r.imported_at),
    ...(r.line_count !== undefined ? { lineCount: Number(r.line_count) } : {}),
    ...(r.unmatched_count !== undefined ? { unmatchedCount: Number(r.unmatched_count) } : {}),
  };
}

export interface SettlementLineRow {
  id: string;
  settlement_id: string;
  intent_id: string | null;
  refund_id: string | null;
  external_ref: string;
  kind: SettlementLineDto['kind'];
  amount_minor: bigint;
  fee_minor: bigint;
  occurred_at: Date | null;
  matched: boolean;
}

export function toSettlementLineDto(r: SettlementLineRow): SettlementLineDto {
  return {
    id: r.id,
    settlementId: r.settlement_id,
    intentId: r.intent_id,
    refundId: r.refund_id,
    externalRef: r.external_ref,
    kind: r.kind,
    amountMinor: minor(r.amount_minor),
    feeMinor: minor(r.fee_minor),
    occurredAt: isoOrNull(r.occurred_at),
    matched: r.matched,
  };
}

export interface ExceptionRow {
  id: string;
  tenant_id: string;
  domain: string;
  kind: string;
  severity: ReconciliationExceptionDto['severity'];
  subject_kind: string | null;
  subject_id: string | null;
  details: Record<string, unknown>;
  status: ReconciliationExceptionDto['status'];
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution_note: string | null;
  created_at: Date;
}

export function toExceptionDto(r: ExceptionRow): ReconciliationExceptionDto {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    domain: r.domain,
    kind: r.kind,
    severity: r.severity,
    subjectKind: r.subject_kind,
    subjectId: r.subject_id,
    details: r.details,
    status: r.status,
    resolvedBy: r.resolved_by,
    resolvedAt: isoOrNull(r.resolved_at),
    resolutionNote: r.resolution_note,
    createdAt: iso(r.created_at),
  };
}
