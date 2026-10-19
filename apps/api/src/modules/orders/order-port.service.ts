import { Injectable } from '@nestjs/common';
import type { TenantUnitOfWork } from '@pos/db';
import type { orders } from '@pos/domain-core';

import { NotFoundError } from '../kernel/public/index.js';
import { CommandContextFactory } from './command-context.factory.js';
import { domain, type OrderState, type ReducerResult } from './domain.js';
import { OrderCommitter, orderEvent } from './order.committer.js';
import { OrderRepository } from './order.repository.js';
import { rules } from './rule-errors.js';

/**
 * OrderPort for S-F5 payments (declared in @pos/domain-core). Every method runs inside the CALLER'S
 * transaction (`tx`), so "payment captured" and "order updated" commit or roll back together.
 * No permission checks: the caller (the payments module) has authorised the payment already.
 * Payment commands are idempotent per `paymentRef`: replaying one returns the current totals.
 */
@Injectable()
export class OrderPortService implements orders.OrderPort<TenantUnitOfWork> {
  constructor(
    private readonly repo: OrderRepository,
    private readonly committer: OrderCommitter,
    private readonly commands: CommandContextFactory,
  ) {}

  async getTotals(tx: TenantUnitOfWork, orderId: string): Promise<orders.OrderTotalsView> {
    const order = await this.repo.find(tx.db, orderId);
    if (!order) throw new NotFoundError();
    return domain.totalsViewOf(order);
  }

  async applyPayment(
    tx: TenantUnitOfWork,
    input: orders.ApplyPaymentInput,
  ): Promise<orders.OrderTotalsView> {
    const before = await this.lock(tx, input.orderId);
    if (await this.repo.hasEvent(tx.db, input.orderId, 'payment_applied', input.paymentRef))
      return domain.totalsViewOf(before);
    const cc = this.commands.make();
    const result = await rules(() =>
      domain.applyPayment(
        before,
        {
          ...(input.checkId ? { checkId: input.checkId } : {}),
          amountMinor: input.amountMinor,
          ...(input.tipMinor !== undefined ? { tipMinor: input.tipMinor } : {}),
          ...(input.roundingMinor !== undefined ? { roundingMinor: input.roundingMinor } : {}),
          paymentRef: input.paymentRef,
          ...(input.method ? { method: input.method } : {}),
        },
        cc,
      ),
    );
    await this.committer.commit(tx, before, result, { meta: this.commands.eventMeta(cc) });
    return domain.totalsViewOf(result.state);
  }

  async markPaid(
    tx: TenantUnitOfWork,
    input: orders.MarkPaidInput,
  ): Promise<orders.OrderTotalsView> {
    const before = await this.lock(tx, input.orderId);
    if (before.status === 'completed') return domain.totalsViewOf(before);
    const cc = this.commands.make();
    const result = await rules(() => domain.markPaid(before, cc));
    await this.committer.commit(tx, before, result, {
      meta: this.commands.eventMeta(cc),
      emits: [
        orderEvent('order.completed', result.state, { paymentRef: input.paymentRef ?? null }),
      ],
    });
    // a completed return or exchange refunds its returned lines to the source order
    if ((before.kind === 'return' || before.kind === 'exchange') && before.sourceOrderId) {
      const source = await this.repo.find(tx.db, before.sourceOrderId, { lock: true });
      if (source) {
        const refunded: ReducerResult = await rules(() =>
          domain.applyReturnRefundToSource(result.state, source, cc),
        );
        await this.repo.save(tx.db, source, refunded.state);
        await this.repo.appendEvents(
          tx.db,
          source.id,
          refunded.events,
          this.commands.eventMeta(cc),
        );
      }
    }
    return domain.totalsViewOf(result.state);
  }

  async applyRefund(
    tx: TenantUnitOfWork,
    input: orders.ApplyRefundInput,
  ): Promise<orders.OrderTotalsView> {
    const before = await this.lock(tx, input.orderId);
    if (await this.repo.hasEvent(tx.db, input.orderId, 'refund_applied', input.paymentRef))
      return domain.totalsViewOf(before);
    const cc = this.commands.make();
    const result = await rules(() =>
      domain.applyRefund(
        before,
        {
          ...(input.checkId ? { checkId: input.checkId } : {}),
          amountMinor: input.amountMinor,
          paymentRef: input.paymentRef,
          ...(input.reason ? { reason: input.reason } : {}),
        },
        cc,
      ),
    );
    await this.committer.commit(tx, before, result, { meta: this.commands.eventMeta(cc) });
    return domain.totalsViewOf(result.state);
  }

  async reopenOffline(
    tx: TenantUnitOfWork,
    input: orders.ReopenOfflineInput,
  ): Promise<orders.OrderTotalsView> {
    const before = await this.lock(tx, input.orderId);
    if (before.status === 'open') return domain.totalsViewOf(before);
    const cc = this.commands.make();
    const result = await rules(() =>
      domain.reopenOffline(
        before,
        {
          ...(input.checkId ? { checkId: input.checkId } : {}),
          reversedMinor: input.reversedMinor,
          reason: input.reason,
          ...(input.paymentRef ? { paymentRef: input.paymentRef } : {}),
        },
        cc,
      ),
    );
    await this.committer.commit(tx, before, result, { meta: this.commands.eventMeta(cc) });
    return domain.totalsViewOf(result.state);
  }

  private async lock(tx: TenantUnitOfWork, orderId: string): Promise<OrderState> {
    const order = await this.repo.find(tx.db, orderId, { lock: true });
    if (!order) throw new NotFoundError();
    return order;
  }
}
