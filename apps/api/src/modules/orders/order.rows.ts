import type {
  CheckDto,
  OrderChargeDto,
  OrderDiscountDto,
  OrderDto,
  OrderLineDto,
  OrderSummaryDto,
} from '@pos/contracts';

import type { Check, ChargeKind, DiscountKind, OrderLine, OrderState } from './domain.js';

/** Row shapes as pg returns them (snake_case; bigint already parsed to bigint; numeric as text; dates via to_char). */

export interface OrderRow {
  id: string;
  tenant_id: string;
  location_id: string;
  register_id: string | null;
  device_id: string | null;
  order_number: number | null;
  client_order_ref: string | null;
  business_date: string;
  kind: OrderState['kind'];
  channel: OrderState['channel'];
  status: OrderState['status'];
  fulfillment_status: OrderState['fulfillmentStatus'];
  payment_status: OrderState['paymentStatus'];
  customer_id: string | null;
  table_session_id: string | null;
  guest_count: number | null;
  employee_id: string | null;
  currency: string;
  pricing_mode: OrderState['pricingMode'];
  price_list_id: string | null;
  config_version: number | null;
  subtotal_minor: bigint;
  discount_minor: bigint;
  tax_minor: bigint;
  charges_minor: bigint;
  tip_minor: bigint;
  rounding_minor: bigint;
  total_minor: bigint;
  paid_minor: bigint;
  refunded_minor: bigint;
  source_order_id: string | null;
  external_ref: string | null;
  scheduled_for: Date | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  placed_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  voided_at: Date | null;
  void_reason: string | null;
  void_approval_id: string | null;
  reopened_at: Date | null;
  reopened_reason: OrderState['reopenedReason'];
  client_created_at: Date | null;
  synced_at: Date | null;
  settlement_pending: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface CheckRow {
  id: string;
  number: number;
  label: string | null;
  status: Check['status'];
  subtotal_minor: bigint;
  discount_minor: bigint;
  tax_minor: bigint;
  charges_minor: bigint;
  tip_minor: bigint;
  rounding_minor: bigint;
  total_minor: bigint;
  paid_minor: bigint;
  refunded_minor: bigint;
  closed_at: Date | null;
  closed_by: string | null;
  version: number;
}

export interface LineRow {
  id: string;
  check_id: string;
  seq: number;
  parent_line_id: string | null;
  variant_id: string | null;
  item_snapshot: Record<string, unknown>;
  quantity: string;
  unit_of_measure: string;
  list_price_minor: bigint;
  unit_price_minor: bigint;
  price_override_reason: string | null;
  price_override_approval_id: string | null;
  discount_minor: bigint;
  tax_minor: bigint;
  total_minor: bigint;
  seat_number: number | null;
  course_number: number | null;
  status: OrderLine['status'];
  void_reason: string | null;
  voided_by: string | null;
  void_approval_id: string | null;
  voided_at: Date | null;
  kitchen_status: OrderLine['kitchenStatus'];
  fulfillment_mode: OrderLine['fulfillmentMode'];
  return_of_line_id: string | null;
  returned_quantity: string;
  notes: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface ModifierRow {
  id: string;
  order_line_id: string;
  modifier_id: string | null;
  group_name: string | null;
  name: string;
  kind: string;
  quantity: number;
  price_delta_minor: bigint;
}

export interface TaxRow {
  id: string;
  order_line_id: string;
  tax_rule_id: string | null;
  tax_name: string;
  rate: string;
  taxable_minor: bigint;
  tax_minor: bigint;
  inclusive: boolean;
  exempt_reason: string | null;
}

export interface DiscountRow {
  id: string;
  order_line_id: string | null;
  kind: DiscountKind;
  promotion_id: string | null;
  coupon_id: string | null;
  description: string;
  percent: string | null;
  amount_minor: bigint;
  approval_id: string | null;
  applied_by: string | null;
  applied_at: Date;
  trace: unknown;
}

export interface ChargeRow {
  id: string;
  check_id: string | null;
  kind: ChargeKind;
  description: string;
  amount_minor: bigint;
  tax_minor: bigint;
  is_gratuity: boolean;
  distribution: { percent?: string | null; taxable?: boolean } | null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Pricing-engine bookkeeping that has no column lives under metadata keys starting with `_`. */
export const GROSS_OVERRIDE_KEY = '_grossOverrideMinor';

export function visibleMetadata(
  metadata: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata).filter(([k]) => !k.startsWith('_')));
}

export function stateFromRows(
  o: OrderRow,
  checks: CheckRow[],
  lines: LineRow[],
  modifiers: ModifierRow[],
  taxes: TaxRow[],
  discounts: DiscountRow[],
  charges: ChargeRow[],
): OrderState {
  const mods = groupBy(modifiers, (m) => m.order_line_id);
  const taxByLine = groupBy(taxes, (t) => t.order_line_id);
  const firstCheck = checks[0]?.id;
  return {
    id: o.id,
    tenantId: o.tenant_id,
    locationId: o.location_id,
    registerId: o.register_id,
    deviceId: o.device_id,
    orderNumber: o.order_number,
    clientOrderRef: o.client_order_ref,
    businessDate: o.business_date,
    kind: o.kind,
    channel: o.channel,
    status: o.status,
    fulfillmentStatus: o.fulfillment_status,
    paymentStatus: o.payment_status,
    customerId: o.customer_id,
    tableSessionId: o.table_session_id,
    guestCount: o.guest_count,
    employeeId: o.employee_id,
    currency: o.currency.trim(),
    pricingMode: o.pricing_mode,
    priceListId: o.price_list_id,
    configVersion: o.config_version,
    subtotalMinor: o.subtotal_minor,
    discountMinor: o.discount_minor,
    taxMinor: o.tax_minor,
    chargesMinor: o.charges_minor,
    tipMinor: o.tip_minor,
    roundingMinor: o.rounding_minor,
    totalMinor: o.total_minor,
    paidMinor: o.paid_minor,
    refundedMinor: o.refunded_minor,
    sourceOrderId: o.source_order_id,
    externalRef: o.external_ref,
    scheduledFor: iso(o.scheduled_for),
    notes: o.notes,
    metadata: o.metadata ?? {},
    placedAt: iso(o.placed_at),
    completedAt: iso(o.completed_at),
    cancelledAt: iso(o.cancelled_at),
    voidedAt: iso(o.voided_at),
    voidReason: o.void_reason,
    voidApprovalId: o.void_approval_id,
    reopenedAt: iso(o.reopened_at),
    reopenedReason: o.reopened_reason,
    clientCreatedAt: iso(o.client_created_at),
    syncedAt: iso(o.synced_at),
    settlementPending: o.settlement_pending,
    version: o.version,
    createdAt: o.created_at.toISOString(),
    updatedAt: o.updated_at.toISOString(),
    checks: checks.map((c): Check => ({
      id: c.id,
      number: c.number,
      label: c.label,
      status: c.status,
      subtotalMinor: c.subtotal_minor,
      discountMinor: c.discount_minor,
      taxMinor: c.tax_minor,
      chargesMinor: c.charges_minor,
      tipMinor: c.tip_minor,
      roundingMinor: c.rounding_minor,
      totalMinor: c.total_minor,
      paidMinor: c.paid_minor,
      refundedMinor: c.refunded_minor,
      closedAt: iso(c.closed_at),
      closedBy: c.closed_by,
      version: c.version,
    })),
    lines: lines.map((l): OrderLine => {
      const snap = l.item_snapshot as Record<string, string | null | undefined>;
      const rawOverride = l.metadata?.[GROSS_OVERRIDE_KEY];
      return {
        id: l.id,
        checkId: l.check_id,
        seq: l.seq,
        parentLineId: l.parent_line_id,
        variantId: l.variant_id,
        itemSnapshot: {
          itemId: snap.item_id ?? null,
          name: snap.name ?? '',
          sku: snap.sku ?? null,
          kind: snap.kind ?? null,
          taxClassCode: snap.tax_class_code ?? null,
          categoryPath: snap.category_path ?? null,
        },
        quantity: l.quantity,
        unitOfMeasure: l.unit_of_measure,
        listPriceMinor: l.list_price_minor,
        unitPriceMinor: l.unit_price_minor,
        priceOverrideReason: l.price_override_reason,
        priceOverrideApprovalId: l.price_override_approval_id,
        modifiers: (mods.get(l.id) ?? []).map((m) => ({
          id: m.id,
          modifierId: m.modifier_id,
          groupName: m.group_name,
          name: m.name,
          kind: m.kind,
          quantity: m.quantity,
          priceDeltaMinor: m.price_delta_minor,
        })),
        discountMinor: l.discount_minor,
        taxMinor: l.tax_minor,
        totalMinor: l.total_minor,
        taxes: (taxByLine.get(l.id) ?? []).map((t) => ({
          taxRuleId: t.tax_rule_id,
          taxName: t.tax_name,
          rate: t.rate,
          taxableMinor: t.taxable_minor,
          taxMinor: t.tax_minor,
          inclusive: t.inclusive,
          exemptReason: t.exempt_reason,
        })),
        seatNumber: l.seat_number,
        courseNumber: l.course_number,
        status: l.status,
        voidReason: l.void_reason,
        voidedBy: l.voided_by,
        voidApprovalId: l.void_approval_id,
        voidedAt: iso(l.voided_at),
        kitchenStatus: l.kitchen_status,
        fulfillmentMode: l.fulfillment_mode,
        returnOfLineId: l.return_of_line_id,
        returnedQuantity: l.returned_quantity,
        notes: l.notes,
        grossOverrideMinor: typeof rawOverride === 'string' ? BigInt(rawOverride) : null,
        metadata: l.metadata ?? {},
        createdAt: l.created_at.toISOString(),
      };
    }),
    discounts: discounts.map((d) => ({
      id: d.id,
      orderLineId: d.order_line_id,
      kind: d.kind,
      promotionId: d.promotion_id,
      couponId: d.coupon_id,
      description: d.description,
      percent: d.percent,
      amountMinor: d.amount_minor,
      approvalId: d.approval_id,
      appliedBy: d.applied_by,
      appliedAt: d.applied_at.toISOString(),
      trace: d.trace ?? null,
    })),
    charges: charges.map((c) => ({
      id: c.id,
      checkId: c.check_id ?? firstCheck ?? '',
      kind: c.kind,
      description: c.description,
      amountMinor: c.amount_minor,
      percent: c.distribution?.percent ?? null,
      taxable: c.distribution?.taxable ?? true,
      taxMinor: c.tax_minor,
      isGratuity: c.is_gratuity,
    })),
  };
}

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

// ---------------------------------------------------------------------------
// state → wire DTO
// ---------------------------------------------------------------------------

const m = (n: bigint): string => n.toString();

export function toCheckDto(c: Check): CheckDto {
  return {
    id: c.id,
    number: c.number,
    label: c.label,
    status: c.status,
    subtotalMinor: m(c.subtotalMinor),
    discountMinor: m(c.discountMinor),
    taxMinor: m(c.taxMinor),
    chargesMinor: m(c.chargesMinor),
    tipMinor: m(c.tipMinor),
    roundingMinor: m(c.roundingMinor),
    totalMinor: m(c.totalMinor),
    paidMinor: m(c.paidMinor),
    refundedMinor: m(c.refundedMinor),
    closedAt: c.closedAt,
    closedBy: c.closedBy,
    version: c.version,
  };
}

export function toLineDto(l: OrderLine): OrderLineDto {
  return {
    id: l.id,
    checkId: l.checkId,
    seq: l.seq,
    parentLineId: l.parentLineId,
    variantId: l.variantId,
    item: {
      itemId: l.itemSnapshot.itemId ?? null,
      name: l.itemSnapshot.name,
      sku: l.itemSnapshot.sku ?? null,
      kind: l.itemSnapshot.kind ?? null,
      taxClassCode: l.itemSnapshot.taxClassCode ?? null,
      categoryPath: l.itemSnapshot.categoryPath ?? null,
    },
    quantity: l.quantity,
    unitOfMeasure: l.unitOfMeasure,
    listPriceMinor: m(l.listPriceMinor),
    unitPriceMinor: m(l.unitPriceMinor),
    priceOverrideReason: l.priceOverrideReason,
    priceOverrideApprovalId: l.priceOverrideApprovalId,
    modifiers: l.modifiers.map((x) => ({ ...x, priceDeltaMinor: m(x.priceDeltaMinor) })),
    discountMinor: m(l.discountMinor),
    taxMinor: m(l.taxMinor),
    totalMinor: m(l.totalMinor),
    taxes: l.taxes.map((t) => ({
      taxRuleId: t.taxRuleId,
      taxName: t.taxName,
      rate: t.rate,
      taxableMinor: m(t.taxableMinor),
      taxMinor: m(t.taxMinor),
      inclusive: t.inclusive,
      exemptReason: t.exemptReason,
    })),
    seatNumber: l.seatNumber,
    courseNumber: l.courseNumber,
    status: l.status,
    voidReason: l.voidReason,
    voidedBy: l.voidedBy,
    voidApprovalId: l.voidApprovalId,
    voidedAt: l.voidedAt,
    kitchenStatus: l.kitchenStatus,
    fulfillmentMode: l.fulfillmentMode,
    returnOfLineId: l.returnOfLineId,
    returnedQuantity: l.returnedQuantity,
    notes: l.notes,
    metadata: visibleMetadata(l.metadata),
    createdAt: l.createdAt,
  };
}

export function toOrderDto(o: OrderState): OrderDto {
  return {
    id: o.id,
    tenantId: o.tenantId,
    locationId: o.locationId,
    registerId: o.registerId,
    deviceId: o.deviceId,
    orderNumber: o.orderNumber,
    clientOrderRef: o.clientOrderRef,
    businessDate: o.businessDate,
    kind: o.kind,
    channel: o.channel,
    status: o.status,
    fulfillmentStatus: o.fulfillmentStatus,
    paymentStatus: o.paymentStatus,
    customerId: o.customerId,
    tableSessionId: o.tableSessionId,
    guestCount: o.guestCount,
    employeeId: o.employeeId,
    currency: o.currency,
    pricingMode: o.pricingMode,
    subtotalMinor: m(o.subtotalMinor),
    discountMinor: m(o.discountMinor),
    taxMinor: m(o.taxMinor),
    chargesMinor: m(o.chargesMinor),
    tipMinor: m(o.tipMinor),
    roundingMinor: m(o.roundingMinor),
    totalMinor: m(o.totalMinor),
    paidMinor: m(o.paidMinor),
    refundedMinor: m(o.refundedMinor),
    sourceOrderId: o.sourceOrderId,
    externalRef: o.externalRef,
    scheduledFor: o.scheduledFor,
    notes: o.notes,
    metadata: o.metadata as Record<string, unknown>,
    placedAt: o.placedAt,
    completedAt: o.completedAt,
    cancelledAt: o.cancelledAt,
    voidedAt: o.voidedAt,
    voidReason: o.voidReason,
    voidApprovalId: o.voidApprovalId,
    reopenedAt: o.reopenedAt,
    reopenedReason: o.reopenedReason,
    clientCreatedAt: o.clientCreatedAt,
    version: o.version,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    checks: o.checks.map(toCheckDto),
    lines: o.lines.map(toLineDto),
    discounts: o.discounts.map((d): OrderDiscountDto => ({
      id: d.id,
      orderLineId: d.orderLineId,
      kind: d.kind,
      promotionId: d.promotionId,
      couponId: d.couponId,
      description: d.description,
      percent: d.percent,
      amountMinor: m(d.amountMinor),
      approvalId: d.approvalId,
      appliedBy: d.appliedBy,
      appliedAt: d.appliedAt,
    })),
    charges: o.charges.map((c): OrderChargeDto => ({
      id: c.id,
      checkId: c.checkId,
      kind: c.kind,
      description: c.description,
      amountMinor: m(c.amountMinor),
      percent: c.percent,
      taxable: c.taxable,
      taxMinor: m(c.taxMinor),
      isGratuity: c.isGratuity,
    })),
  };
}

export interface SummaryRow {
  id: string;
  location_id: string;
  order_number: number | null;
  client_order_ref: string | null;
  business_date: string;
  kind: OrderSummaryDto['kind'];
  status: OrderSummaryDto['status'];
  fulfillment_status: OrderSummaryDto['fulfillmentStatus'];
  payment_status: OrderSummaryDto['paymentStatus'];
  currency: string;
  total_minor: bigint;
  paid_minor: bigint;
  version: number;
  created_at: Date;
}

export function toSummaryDto(r: SummaryRow): OrderSummaryDto {
  return {
    id: r.id,
    locationId: r.location_id,
    orderNumber: r.order_number,
    clientOrderRef: r.client_order_ref,
    businessDate: r.business_date,
    kind: r.kind,
    status: r.status,
    fulfillmentStatus: r.fulfillment_status,
    paymentStatus: r.payment_status,
    currency: r.currency.trim(),
    totalMinor: m(r.total_minor),
    paidMinor: m(r.paid_minor),
    version: r.version,
    createdAt: r.created_at.toISOString(),
  };
}
