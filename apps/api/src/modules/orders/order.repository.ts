import { Injectable } from '@nestjs/common';
import type { ListOrdersQuery } from '@pos/contracts';
import { newId, type TenantScopedDb } from '@pos/db';

import {
  type ChargeRow,
  type CheckRow,
  type DiscountRow,
  type LineRow,
  type ModifierRow,
  type OrderRow,
  type SummaryRow,
  type TaxRow,
  GROSS_OVERRIDE_KEY,
  stateFromRows,
} from './order.rows.js';
import { domain, type Check, type OrderEvent, type OrderLine, type OrderState } from './domain.js';
import { VersionConflictError } from '../kernel/public/index.js';

const json = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

const ORDER_COLUMNS = "o.*, to_char(o.business_date, 'YYYY-MM-DD') AS business_date";

export interface EventMeta {
  readonly actorUserId: string | null;
  readonly deviceId: string | null;
  readonly clientCommandId: string | null;
  readonly now: string;
}

/**
 * Persistence of the order aggregate. Every statement names `tenant_id` explicitly (RLS is the
 * second layer). Mutations lock the order row first (`find(..., { lock: true })`), so concurrent
 * commands on one order serialise; `save` then double-checks the version it loaded.
 */
@Injectable()
export class OrderRepository {
  async find(
    db: TenantScopedDb,
    id: string,
    options: { lock?: boolean } = {},
  ): Promise<OrderState | null> {
    const t = db.tenantId;
    const order = await db.maybeOne<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders.orders o WHERE o.tenant_id = $1 AND o.id = $2 ${options.lock ? 'FOR UPDATE' : ''}`,
      [t, id],
    );
    if (!order) return null;
    const [checks, lines, modifiers, taxes, discounts, charges] = await Promise.all([
      db.query<CheckRow>(
        'SELECT * FROM orders.checks WHERE tenant_id = $1 AND order_id = $2 ORDER BY number',
        [t, id],
      ),
      db.query<LineRow>(
        'SELECT * FROM orders.order_lines WHERE tenant_id = $1 AND order_id = $2 ORDER BY seq',
        [t, id],
      ),
      db.query<ModifierRow>(
        `SELECT m.* FROM orders.order_line_modifiers m JOIN orders.order_lines l ON l.tenant_id = m.tenant_id AND l.id = m.order_line_id
         WHERE m.tenant_id = $1 AND l.order_id = $2 ORDER BY m.id`,
        [t, id],
      ),
      db.query<TaxRow>(
        `SELECT x.* FROM orders.order_line_taxes x JOIN orders.order_lines l ON l.tenant_id = x.tenant_id AND l.id = x.order_line_id
         WHERE x.tenant_id = $1 AND l.order_id = $2 ORDER BY x.id`,
        [t, id],
      ),
      db.query<DiscountRow>(
        'SELECT * FROM orders.order_discounts WHERE tenant_id = $1 AND order_id = $2 ORDER BY id',
        [t, id],
      ),
      db.query<ChargeRow>(
        'SELECT * FROM orders.order_charges WHERE tenant_id = $1 AND order_id = $2 ORDER BY id',
        [t, id],
      ),
    ]);
    return stateFromRows(order, checks, lines, modifiers, taxes, discounts, charges);
  }

  /** Cheap pre-flight for authorization: where the order sits, without loading it. */
  async locate(
    db: TenantScopedDb,
    id: string,
  ): Promise<{
    locationId: string;
    status: OrderState['status'];
    kind: OrderState['kind'];
    channel: OrderState['channel'];
    sourceOrderId: string | null;
  } | null> {
    const row = await db.maybeOne<{
      location_id: string;
      status: OrderState['status'];
      kind: OrderState['kind'];
      channel: OrderState['channel'];
      source_order_id: string | null;
    }>(
      'SELECT location_id, status, kind, channel, source_order_id FROM orders.orders WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, id],
    );
    return (
      row && {
        locationId: row.location_id,
        status: row.status,
        kind: row.kind,
        channel: row.channel,
        sourceOrderId: row.source_order_id,
      }
    );
  }

  async findByClientRef(
    db: TenantScopedDb,
    locationId: string,
    ref: string,
  ): Promise<string | null> {
    const row = await db.maybeOne<{ id: string }>(
      'SELECT id FROM orders.orders WHERE tenant_id = $1 AND location_id = $2 AND client_order_ref = $3',
      [db.tenantId, locationId, ref],
    );
    return row?.id ?? null;
  }

  /** Canonical order number: one atomic upsert per (location, business date). */
  async nextOrderNumber(
    db: TenantScopedDb,
    locationId: string,
    businessDate: string,
  ): Promise<number> {
    const row = await db.one<{ order_number: number }>(domain.NEXT_ORDER_NUMBER_SQL, [
      db.tenantId,
      locationId,
      businessDate,
    ]);
    return Number(row.order_number);
  }

  async insert(db: TenantScopedDb, order: OrderState): Promise<void> {
    await db.query(
      `INSERT INTO orders.orders (id, tenant_id, location_id, register_id, device_id, order_number, client_order_ref, business_date, kind, channel,
         status, fulfillment_status, payment_status, customer_id, table_session_id, guest_count, employee_id, currency, pricing_mode, price_list_id,
         config_version, subtotal_minor, discount_minor, tax_minor, charges_minor, tip_minor, rounding_minor, total_minor, paid_minor, refunded_minor,
         source_order_id, external_ref, scheduled_for, notes, metadata, placed_at, completed_at, cancelled_at, voided_at, void_reason, void_approval_id,
         reopened_at, reopened_reason, client_created_at, synced_at, settlement_pending, version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,
               $37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48,$49)`,
      [
        order.id,
        order.tenantId,
        order.locationId,
        order.registerId,
        order.deviceId,
        order.orderNumber,
        order.clientOrderRef,
        order.businessDate,
        order.kind,
        order.channel,
        order.status,
        order.fulfillmentStatus,
        order.paymentStatus,
        order.customerId,
        order.tableSessionId,
        order.guestCount,
        order.employeeId,
        order.currency,
        order.pricingMode,
        order.priceListId,
        order.configVersion,
        order.subtotalMinor,
        order.discountMinor,
        order.taxMinor,
        order.chargesMinor,
        order.tipMinor,
        order.roundingMinor,
        order.totalMinor,
        order.paidMinor,
        order.refundedMinor,
        order.sourceOrderId,
        order.externalRef,
        order.scheduledFor,
        order.notes,
        json(order.metadata),
        order.placedAt,
        order.completedAt,
        order.cancelledAt,
        order.voidedAt,
        order.voidReason,
        order.voidApprovalId,
        order.reopenedAt,
        order.reopenedReason,
        order.clientCreatedAt,
        order.syncedAt,
        order.settlementPending,
        order.version,
        order.createdAt,
        order.updatedAt,
      ],
    );
    await this.writeChildren(db, undefined, order);
  }

  /** Write `after` over `before`: the order row (guarded by the loaded version), then only what changed. */
  async save(db: TenantScopedDb, before: OrderState, after: OrderState): Promise<void> {
    const updated = await db.query(
      `UPDATE orders.orders SET order_number = $4, business_date = $5, status = $6, fulfillment_status = $7, payment_status = $8,
         customer_id = $9, table_session_id = $10, guest_count = $11, employee_id = $12, subtotal_minor = $13, discount_minor = $14,
         tax_minor = $15, charges_minor = $16, tip_minor = $17, rounding_minor = $18, total_minor = $19, paid_minor = $20, refunded_minor = $21,
         external_ref = $22, scheduled_for = $23, notes = $24, metadata = $25, placed_at = $26, completed_at = $27, cancelled_at = $28,
         voided_at = $29, void_reason = $30, void_approval_id = $31, reopened_at = $32, reopened_reason = $33, settlement_pending = $34, version = $35
       WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING id`,
      [
        db.tenantId,
        after.id,
        before.version,
        after.orderNumber,
        after.businessDate,
        after.status,
        after.fulfillmentStatus,
        after.paymentStatus,
        after.customerId,
        after.tableSessionId,
        after.guestCount,
        after.employeeId,
        after.subtotalMinor,
        after.discountMinor,
        after.taxMinor,
        after.chargesMinor,
        after.tipMinor,
        after.roundingMinor,
        after.totalMinor,
        after.paidMinor,
        after.refundedMinor,
        after.externalRef,
        after.scheduledFor,
        after.notes,
        json(after.metadata),
        after.placedAt,
        after.completedAt,
        after.cancelledAt,
        after.voidedAt,
        after.voidReason,
        after.voidApprovalId,
        after.reopenedAt,
        after.reopenedReason,
        after.settlementPending,
        after.version,
      ],
    );
    if (updated.length === 0) throw new VersionConflictError(before.version);
    await this.writeChildren(db, before, after);
  }

  private async writeChildren(
    db: TenantScopedDb,
    before: OrderState | undefined,
    after: OrderState,
  ): Promise<void> {
    const t = db.tenantId;
    const prevChecks = new Map((before?.checks ?? []).map((c) => [c.id, c]));
    for (const c of after.checks) {
      const old = prevChecks.get(c.id);
      if (!old) await this.insertCheck(db, after.id, c);
      else if (changed(old, c)) await this.updateCheck(db, c);
    }

    const prevLines = new Map((before?.lines ?? []).map((l) => [l.id, l]));
    const keep = new Set(after.lines.map((l) => l.id));
    // delete removed lines, children (higher seq) first so the parent FK never dangles
    const removed = (before?.lines ?? [])
      .filter((l) => !keep.has(l.id))
      .sort((a, b) => b.seq - a.seq);
    for (const l of removed)
      await db.query('DELETE FROM orders.order_lines WHERE tenant_id = $1 AND id = $2', [t, l.id]);
    for (const l of [...after.lines].sort((a, b) => a.seq - b.seq)) {
      const old = prevLines.get(l.id);
      if (!old) {
        await this.insertLine(db, after.id, l);
        await this.writeModifiers(db, l, false);
        await this.writeTaxes(db, l, false);
        continue;
      }
      if (changed(lineScalars(old), lineScalars(l))) await this.updateLine(db, l);
      if (changed(old.modifiers, l.modifiers)) await this.writeModifiers(db, l, true);
      if (changed(old.taxes, l.taxes)) await this.writeTaxes(db, l, true);
    }

    const prevDiscounts = new Map((before?.discounts ?? []).map((d) => [d.id, d]));
    const keepDiscounts = new Set(after.discounts.map((d) => d.id));
    for (const d of before?.discounts ?? [])
      if (!keepDiscounts.has(d.id))
        await db.query('DELETE FROM orders.order_discounts WHERE tenant_id = $1 AND id = $2', [
          t,
          d.id,
        ]);
    for (const d of after.discounts) {
      const old = prevDiscounts.get(d.id);
      if (!old) {
        await db.query(
          `INSERT INTO orders.order_discounts (id, tenant_id, order_id, order_line_id, kind, promotion_id, coupon_id, description, percent, amount_minor, approval_id, applied_by, applied_at, trace)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            d.id,
            t,
            after.id,
            d.orderLineId,
            d.kind,
            d.promotionId,
            d.couponId,
            d.description,
            d.percent,
            d.amountMinor,
            d.approvalId,
            d.appliedBy,
            d.appliedAt,
            d.trace === null ? null : json(d.trace),
          ],
        );
      } else if (changed(old, d)) {
        await db.query(
          'UPDATE orders.order_discounts SET order_line_id = $3, percent = $4, amount_minor = $5, trace = $6 WHERE tenant_id = $1 AND id = $2',
          [
            t,
            d.id,
            d.orderLineId,
            d.percent,
            d.amountMinor,
            d.trace === null ? null : json(d.trace),
          ],
        );
      }
    }

    const prevCharges = new Map((before?.charges ?? []).map((c) => [c.id, c]));
    const keepCharges = new Set(after.charges.map((c) => c.id));
    for (const c of before?.charges ?? [])
      if (!keepCharges.has(c.id))
        await db.query('DELETE FROM orders.order_charges WHERE tenant_id = $1 AND id = $2', [
          t,
          c.id,
        ]);
    for (const c of after.charges) {
      const old = prevCharges.get(c.id);
      const distribution = json({ percent: c.percent, taxable: c.taxable });
      if (!old) {
        await db.query(
          `INSERT INTO orders.order_charges (id, tenant_id, order_id, check_id, kind, description, amount_minor, tax_minor, is_gratuity, distribution)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            c.id,
            t,
            after.id,
            c.checkId,
            c.kind,
            c.description,
            c.amountMinor,
            c.taxMinor,
            c.isGratuity,
            distribution,
          ],
        );
      } else if (changed(old, c)) {
        await db.query(
          'UPDATE orders.order_charges SET check_id = $3, amount_minor = $4, tax_minor = $5, distribution = $6 WHERE tenant_id = $1 AND id = $2',
          [t, c.id, c.checkId, c.amountMinor, c.taxMinor, distribution],
        );
      }
    }
  }

  private insertCheck(db: TenantScopedDb, orderId: string, c: Check): Promise<unknown> {
    return db.query(
      `INSERT INTO orders.checks (id, tenant_id, order_id, number, label, status, subtotal_minor, discount_minor, tax_minor, charges_minor, tip_minor,
         rounding_minor, total_minor, paid_minor, refunded_minor, closed_at, closed_by, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        c.id,
        db.tenantId,
        orderId,
        c.number,
        c.label,
        c.status,
        c.subtotalMinor,
        c.discountMinor,
        c.taxMinor,
        c.chargesMinor,
        c.tipMinor,
        c.roundingMinor,
        c.totalMinor,
        c.paidMinor,
        c.refundedMinor,
        c.closedAt,
        c.closedBy,
        c.version,
      ],
    );
  }

  private updateCheck(db: TenantScopedDb, c: Check): Promise<unknown> {
    return db.query(
      `UPDATE orders.checks SET label = $3, status = $4, subtotal_minor = $5, discount_minor = $6, tax_minor = $7, charges_minor = $8, tip_minor = $9,
         rounding_minor = $10, total_minor = $11, paid_minor = $12, refunded_minor = $13, closed_at = $14, closed_by = $15, version = $16
       WHERE tenant_id = $1 AND id = $2`,
      [
        db.tenantId,
        c.id,
        c.label,
        c.status,
        c.subtotalMinor,
        c.discountMinor,
        c.taxMinor,
        c.chargesMinor,
        c.tipMinor,
        c.roundingMinor,
        c.totalMinor,
        c.paidMinor,
        c.refundedMinor,
        c.closedAt,
        c.closedBy,
        c.version,
      ],
    );
  }

  private lineParams(l: OrderLine): unknown[] {
    const metadata = { ...l.metadata };
    delete metadata[GROSS_OVERRIDE_KEY];
    if (l.grossOverrideMinor !== null)
      metadata[GROSS_OVERRIDE_KEY] = l.grossOverrideMinor.toString();
    const s = l.itemSnapshot;
    return [
      l.checkId,
      l.seq,
      l.parentLineId,
      l.variantId,
      json({
        item_id: s.itemId ?? null,
        name: s.name,
        sku: s.sku ?? null,
        kind: s.kind ?? null,
        tax_class_code: s.taxClassCode ?? null,
        category_path: s.categoryPath ?? null,
      }),
      l.quantity,
      l.unitOfMeasure,
      l.listPriceMinor,
      l.unitPriceMinor,
      l.priceOverrideReason,
      l.priceOverrideApprovalId,
      l.discountMinor,
      l.taxMinor,
      l.totalMinor,
      l.seatNumber,
      l.courseNumber,
      l.status,
      l.voidReason,
      l.voidedBy,
      l.voidApprovalId,
      l.voidedAt,
      l.kitchenStatus,
      l.fulfillmentMode,
      l.returnOfLineId,
      l.returnedQuantity,
      l.notes,
      json(metadata),
    ];
  }

  private insertLine(db: TenantScopedDb, orderId: string, l: OrderLine): Promise<unknown> {
    return db.query(
      `INSERT INTO orders.order_lines (id, tenant_id, order_id, check_id, seq, parent_line_id, variant_id, item_snapshot, quantity, unit_of_measure,
         list_price_minor, unit_price_minor, price_override_reason, price_override_approval_id, discount_minor, tax_minor, total_minor, seat_number,
         course_number, status, void_reason, voided_by, void_approval_id, voided_at, kitchen_status, fulfillment_mode, return_of_line_id,
         returned_quantity, notes, metadata, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)`,
      [l.id, db.tenantId, orderId, ...this.lineParams(l), l.createdAt],
    );
  }

  private updateLine(db: TenantScopedDb, l: OrderLine): Promise<unknown> {
    return db.query(
      `UPDATE orders.order_lines SET check_id = $3, seq = $4, parent_line_id = $5, variant_id = $6, item_snapshot = $7, quantity = $8,
         unit_of_measure = $9, list_price_minor = $10, unit_price_minor = $11, price_override_reason = $12, price_override_approval_id = $13,
         discount_minor = $14, tax_minor = $15, total_minor = $16, seat_number = $17, course_number = $18, status = $19, void_reason = $20,
         voided_by = $21, void_approval_id = $22, voided_at = $23, kitchen_status = $24, fulfillment_mode = $25, return_of_line_id = $26,
         returned_quantity = $27, notes = $28, metadata = $29
       WHERE tenant_id = $1 AND id = $2`,
      [db.tenantId, l.id, ...this.lineParams(l)],
    );
  }

  private async writeModifiers(db: TenantScopedDb, l: OrderLine, replace: boolean): Promise<void> {
    if (replace)
      await db.query(
        'DELETE FROM orders.order_line_modifiers WHERE tenant_id = $1 AND order_line_id = $2',
        [db.tenantId, l.id],
      );
    for (const m of l.modifiers)
      await db.query(
        `INSERT INTO orders.order_line_modifiers (id, tenant_id, order_line_id, modifier_id, group_name, name, kind, quantity, price_delta_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          m.id,
          db.tenantId,
          l.id,
          m.modifierId,
          m.groupName,
          m.name,
          m.kind,
          m.quantity,
          m.priceDeltaMinor,
        ],
      );
  }

  private async writeTaxes(db: TenantScopedDb, l: OrderLine, replace: boolean): Promise<void> {
    if (replace)
      await db.query(
        'DELETE FROM orders.order_line_taxes WHERE tenant_id = $1 AND order_line_id = $2',
        [db.tenantId, l.id],
      );
    for (const x of l.taxes)
      await db.query(
        `INSERT INTO orders.order_line_taxes (id, tenant_id, order_line_id, tax_rule_id, tax_name, rate, taxable_minor, tax_minor, inclusive, exempt_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          newId(),
          db.tenantId,
          l.id,
          x.taxRuleId,
          x.taxName,
          x.rate,
          x.taxableMinor,
          x.taxMinor,
          x.inclusive,
          x.exemptReason,
        ],
      );
  }

  // -------------------------------------------------------------------------
  // events (append-only)
  // -------------------------------------------------------------------------

  async appendEvents(
    db: TenantScopedDb,
    orderId: string,
    events: readonly OrderEvent[],
    meta: EventMeta,
  ): Promise<void> {
    for (const e of events)
      await db.query(
        `INSERT INTO orders.order_events (id, tenant_id, order_id, kind, from_status, to_status, actor_user_id, device_id, approval_id, client_command_id, payload, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          newId(),
          db.tenantId,
          orderId,
          e.kind,
          e.fromStatus ?? null,
          e.toStatus ?? null,
          meta.actorUserId,
          meta.deviceId,
          e.approvalId ?? null,
          meta.clientCommandId,
          json(e.payload),
          meta.now,
        ],
      );
  }

  /** Idempotency of payment commands: has this payment reference already been applied? */
  async hasEvent(
    db: TenantScopedDb,
    orderId: string,
    kind: string,
    paymentRef: string,
  ): Promise<boolean> {
    const row = await db.maybeOne<{ n: string }>(
      `SELECT count(*)::text AS n FROM orders.order_events WHERE tenant_id = $1 AND order_id = $2 AND kind = $3 AND payload->>'paymentRef' = $4`,
      [db.tenantId, orderId, kind, paymentRef],
    );
    return Number(row?.n ?? 0) > 0;
  }

  async listEvents(db: TenantScopedDb, orderId: string) {
    return db.query<{
      id: string;
      order_id: string;
      kind: string;
      from_status: string | null;
      to_status: string | null;
      actor_user_id: string | null;
      device_id: string | null;
      approval_id: string | null;
      client_command_id: string | null;
      payload: Record<string, unknown>;
      occurred_at: Date;
      recorded_at: Date;
    }>(
      'SELECT * FROM orders.order_events WHERE tenant_id = $1 AND order_id = $2 ORDER BY occurred_at, recorded_at, id',
      [db.tenantId, orderId],
    );
  }

  async list(
    db: TenantScopedDb,
    q: ListOrdersQuery,
  ): Promise<{ rows: SummaryRow[]; nextCursor: string | null }> {
    const params: unknown[] = [db.tenantId, q.locationId];
    let where = 'tenant_id = $1 AND location_id = $2';
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where += ` AND ${clause.replace('?', `$${params.length}`)}`;
    };
    if (q.status) add('status = ?', q.status);
    if (q.kind) add('kind = ?', q.kind);
    if (q.businessDate) add('business_date = ?::date', q.businessDate);
    if (q.cursor) add('id < ?', q.cursor);
    params.push(q.limit + 1);
    const rows = await db.query<SummaryRow>(
      `SELECT id, location_id, order_number, client_order_ref, to_char(business_date, 'YYYY-MM-DD') AS business_date, kind, status,
              fulfillment_status, payment_status, currency, total_minor, paid_minor, version, created_at
       FROM orders.orders WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, q.limit);
    return { rows: page, nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null };
  }
}

function changed(a: unknown, b: unknown): boolean {
  return json(a) !== json(b);
}

/** A line without its child collections, for change detection. */
function lineScalars(l: OrderLine): Omit<OrderLine, 'modifiers' | 'taxes'> {
  const { modifiers: _m, taxes: _t, ...rest } = l;
  return rest;
}
