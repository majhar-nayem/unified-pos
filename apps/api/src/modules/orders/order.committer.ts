import { Injectable } from '@nestjs/common';
import type { OutboxEventInput, TenantUnitOfWork } from '@pos/db';

import { OrderRepository, type EventMeta } from './order.repository.js';
import type { OrderState, ReducerResult } from './domain.js';

export interface CommitOptions {
  readonly meta: EventMeta;
  readonly approvalId?: string | null;
  readonly onBehalfOf?: string | null;
  readonly emits?: readonly OutboxEventInput[];
  /** Audit action; default `orders.order.<first event kind>`. */
  readonly auditAction?: string;
}

/** Order summary carried by outbox events and audit entries (no customer data, no line detail). */
export function orderSummary(o: OrderState) {
  return {
    orderId: o.id,
    locationId: o.locationId,
    kind: o.kind,
    status: o.status,
    fulfillmentStatus: o.fulfillmentStatus,
    paymentStatus: o.paymentStatus,
    orderNumber: o.orderNumber,
    clientOrderRef: o.clientOrderRef,
    businessDate: o.businessDate,
    currency: o.currency,
    totalMinor: o.totalMinor.toString(),
    paidMinor: o.paidMinor.toString(),
    taxMinor: o.taxMinor.toString(),
    lineCount: o.lines.filter((l) => l.status === 'active').length,
    sourceOrderId: o.sourceOrderId,
    version: o.version,
  };
}

export function orderEvent(
  type: 'order.placed' | 'order.completed' | 'order.voided' | 'order.returned',
  o: OrderState,
  extra: Record<string, unknown> = {},
): OutboxEventInput {
  return {
    type,
    aggregateKind: 'order',
    aggregateId: o.id,
    aggregateVersion: o.version,
    locationId: o.locationId,
    payload: { ...orderSummary(o), ...extra },
  };
}

/** Everything a command writes after the reducer ran: the rows, order_events, audit and outbox. */
@Injectable()
export class OrderCommitter {
  constructor(private readonly repo: OrderRepository) {}

  async commitNew(
    tx: TenantUnitOfWork,
    order: OrderState,
    result: ReducerResult,
    options: CommitOptions,
  ): Promise<void> {
    await this.repo.insert(tx.db, order);
    await this.finish(tx, undefined, result, options);
  }

  async commit(
    tx: TenantUnitOfWork,
    before: OrderState,
    result: ReducerResult,
    options: CommitOptions,
  ): Promise<void> {
    await this.repo.save(tx.db, before, result.state);
    await this.finish(tx, before, result, options);
  }

  private async finish(
    tx: TenantUnitOfWork,
    before: OrderState | undefined,
    result: ReducerResult,
    options: CommitOptions,
  ): Promise<void> {
    const after = result.state;
    await this.repo.appendEvents(tx.db, after.id, result.events, options.meta);
    const first = result.events[0]?.kind ?? 'updated';
    tx.audit({
      action: options.auditAction ?? `orders.order.${first}`,
      resourceKind: 'order',
      resourceId: after.id,
      locationId: after.locationId,
      ...(before
        ? {
            before: {
              status: before.status,
              version: before.version,
              totalMinor: before.totalMinor.toString(),
            },
          }
        : {}),
      after: { ...orderSummary(after), events: result.events.map((e) => e.kind) },
      approvalId: options.approvalId ?? null,
      onBehalfOf: options.onBehalfOf ?? null,
    });
    for (const e of options.emits ?? []) tx.emit(e);
  }
}
