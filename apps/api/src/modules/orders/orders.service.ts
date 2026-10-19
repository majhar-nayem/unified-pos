import { Inject, Injectable } from '@nestjs/common';
import type { PermissionKey, Scope } from '@pos/auth';
import type {
  AddCharge,
  AddOrderLine,
  ApplyDiscount,
  CreateOrder,
  CreateReturn,
  ListOrdersQuery,
  MergeChecks,
  OrderDto,
  OrderEventDto,
  OrderPageDto,
  PlaceOrder,
  SplitChecks,
  SuspendOrder,
  UpdateOrder,
  UpdateOrderLine,
  VoidLine,
  VoidOrder,
} from '@pos/contracts';
import type { OutboxEventInput, TenantUnitOfWork } from '@pos/db';
import type { orders } from '@pos/domain-core';

import {
  AuthorizationService,
  NotFoundError,
  RequestContextService,
  UnitOfWork,
  VersionConflictError,
} from '../kernel/public/index.js';
import { ApprovalGate } from './approval.gate.js';
import { CommandContextFactory } from './command-context.factory.js';
import { domain, type CommandContext, type OrderState, type ReducerResult } from './domain.js';
import { LocationReadModel } from './location.read-model.js';
import { OrderCommitter, orderEvent } from './order.committer.js';
import { OrderRepository } from './order.repository.js';
import { toOrderDto, toSummaryDto } from './order.rows.js';
import { CATALOG_PORT } from './ports.js';
import { rules } from './rule-errors.js';

/** Per-request command options: the If-Match version (when the client sent one) and a client command id for order_events. */
export interface CommandOpts {
  readonly version?: number | undefined;
  readonly commandId?: string | undefined;
}

interface Outcome {
  readonly result: ReducerResult;
  readonly emits?: readonly OutboxEventInput[];
  readonly approvalId?: string | null;
  readonly onBehalfOf?: string | null;
  /** Extra writes in the same transaction (the source order of a return). */
  readonly alsoIn?: (tx: TenantUnitOfWork) => Promise<void>;
}

type Reduce = (
  before: OrderState,
  cc: CommandContext,
  tx: TenantUnitOfWork,
) => Outcome | Promise<Outcome>;

/** Instants are stored and returned in one canonical form (ISO, milliseconds, Z), whatever spelling the client used. */
const isoOrNull = (v: string | undefined | null): string | null =>
  v ? new Date(v).toISOString() : null;

const money = (v: string | undefined): bigint | undefined =>
  v === undefined ? undefined : BigInt(v);

@Injectable()
export class OrdersService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly context: RequestContextService,
    private readonly repo: OrderRepository,
    private readonly committer: OrderCommitter,
    private readonly locations: LocationReadModel,
    private readonly gate: ApprovalGate,
    private readonly commands: CommandContextFactory,
    @Inject(CATALOG_PORT) private readonly catalog: orders.CatalogPort,
  ) {}

  // -------------------------------------------------------------------------
  // queries
  // -------------------------------------------------------------------------

  async get(orderId: string): Promise<OrderDto> {
    await this.authorize(orderId, 'orders.view');
    const order = await this.uow.read((db) => this.repo.find(db, orderId));
    if (!order) throw new NotFoundError();
    return toOrderDto(order);
  }

  async list(query: ListOrdersQuery): Promise<OrderPageDto> {
    await this.authz.assert('orders.view', { kind: 'location', id: query.locationId });
    const page = await this.uow.read((db) => this.repo.list(db, query));
    return { items: page.rows.map(toSummaryDto), nextCursor: page.nextCursor };
  }

  async events(orderId: string): Promise<OrderEventDto[]> {
    await this.authorize(orderId, 'orders.view');
    const rows = await this.uow.read((db) => this.repo.listEvents(db, orderId));
    return rows.map((r) => ({
      id: r.id,
      orderId: r.order_id,
      kind: r.kind,
      fromStatus: r.from_status as OrderEventDto['fromStatus'],
      toStatus: r.to_status as OrderEventDto['toStatus'],
      actorUserId: r.actor_user_id,
      deviceId: r.device_id,
      approvalId: r.approval_id,
      clientCommandId: r.client_command_id,
      payload: r.payload,
      occurredAt: r.occurred_at.toISOString(),
      recordedAt: r.recorded_at.toISOString(),
    }));
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  async create(input: CreateOrder, opts: CommandOpts = {}): Promise<OrderDto> {
    const scope: Scope = { kind: 'location', id: input.locationId };
    await this.authz.assert('orders.create', scope);
    const channel = input.channel ?? 'pos';
    const at = new Date().toISOString();
    // Catalog lookups use their own connections: resolve before the transaction opens.
    const lines = await Promise.all(
      (input.lines ?? []).map(async (line) => ({
        line,
        snapshot: await this.resolveLine(line, { locationId: input.locationId, channel, at }),
      })),
    );
    for (const { line, snapshot } of lines) await this.assertOverrideAllowed(scope, line, snapshot);

    return this.uow.run(async (tx) => {
      if (input.clientOrderRef) {
        const existing = await this.repo.findByClientRef(
          tx.db,
          input.locationId,
          input.clientOrderRef,
        );
        if (existing) {
          const order = await this.repo.find(tx.db, existing);
          if (order) return toOrderDto(order);
        }
      }
      const facts = await this.locations.find(tx.db, input.locationId);
      if (!facts) throw new NotFoundError();
      if (
        input.registerId &&
        !(await this.locations.registerAt(tx.db, input.registerId, input.locationId))
      )
        throw new NotFoundError();
      const cc = this.commands.make();
      const businessDate = domain.resolveBusinessDate({
        now: new Date(cc.now),
        clientCreatedAt: input.clientCreatedAt ? new Date(input.clientCreatedAt) : null,
        timezone: facts.timezone,
        boundary: facts.businessDayBoundary,
      });
      const created = await rules(() =>
        domain.createOrder(
          {
            tenantId: tx.tenantId,
            locationId: input.locationId,
            registerId: input.registerId ?? null,
            businessDate,
            kind: input.kind,
            channel,
            currency: input.currency ?? facts.currency,
            ...(input.pricingMode ? { pricingMode: input.pricingMode } : {}),
            customerId: input.customerId ?? null,
            tableSessionId: input.tableSessionId ?? null,
            guestCount: input.guestCount ?? null,
            employeeId: input.employeeId ?? null,
            clientOrderRef: input.clientOrderRef ?? null,
            clientCreatedAt: isoOrNull(input.clientCreatedAt),
            externalRef: input.externalRef ?? null,
            scheduledFor: isoOrNull(input.scheduledFor),
            notes: input.notes ?? null,
            ...(input.metadata ? { metadata: input.metadata } : {}),
          },
          cc,
        ),
      );
      let state = created.state;
      const events = [...created.events];
      for (const { line, snapshot } of lines) {
        const added = await rules(() => domain.addLine(state, this.lineInput(line, snapshot), cc));
        state = added.state;
        events.push(...added.events);
      }
      const result: ReducerResult = { state: { ...state, version: 1 }, events };
      await this.committer.commitNew(tx, result.state, result, {
        meta: this.commands.eventMeta(cc, opts.commandId ?? null),
        auditAction: 'orders.order.created',
      });
      return toOrderDto(result.state);
    });
  }

  // -------------------------------------------------------------------------
  // lines
  // -------------------------------------------------------------------------

  async addLine(orderId: string, input: AddOrderLine, opts: CommandOpts = {}): Promise<OrderDto> {
    const loc = await this.authorize(orderId, 'orders.create');
    const snapshot = await this.resolveLine(input, {
      locationId: loc.locationId,
      channel: loc.channel,
      at: new Date().toISOString(),
    });
    const gate = await this.overrideGate(
      loc.locationId,
      orderId,
      input.unitPriceMinor,
      snapshot,
      input.priceOverrideApprovalId,
    );
    const approverId = await gate.consume();
    return this.apply(orderId, opts, (before, cc) => {
      const lineInput = this.lineInput(input, snapshot, gate.approvalId);
      return {
        result: domain.addLine(before, lineInput, cc),
        approvalId: gate.approvalId,
        onBehalfOf: approverId,
      };
    });
  }

  async updateLine(
    orderId: string,
    lineId: string,
    patch: UpdateOrderLine,
    opts: CommandOpts,
  ): Promise<OrderDto> {
    const loc = await this.authorize(orderId, 'orders.create');
    let gate: { approvalId: string | null; consume(): Promise<string | null> } = {
      approvalId: null,
      consume: async () => null,
    };
    if (patch.unitPriceMinor !== undefined) {
      const probe = await this.probe(orderId);
      const line = probe.lines.find((l) => l.id === lineId);
      if (line && BigInt(patch.unitPriceMinor) !== line.listPriceMinor)
        gate = await this.overrideGate(
          loc.locationId,
          orderId,
          patch.unitPriceMinor,
          {
            variantId: line.variantId,
            itemSnapshot: line.itemSnapshot,
            unitOfMeasure: line.unitOfMeasure,
            listPriceMinor: line.listPriceMinor,
          },
          patch.priceOverrideApprovalId ?? undefined,
        );
    }
    const approverId = await gate.consume();
    return this.apply(orderId, opts, (before, cc) => ({
      result: domain.updateLine(
        before,
        lineId,
        {
          ...(patch.quantity !== undefined ? { quantity: patch.quantity } : {}),
          ...(patch.unitPriceMinor !== undefined
            ? { unitPriceMinor: BigInt(patch.unitPriceMinor) }
            : {}),
          ...(patch.priceOverrideReason !== undefined
            ? { priceOverrideReason: patch.priceOverrideReason }
            : {}),
          ...(gate.approvalId || patch.priceOverrideApprovalId !== undefined
            ? { priceOverrideApprovalId: gate.approvalId ?? patch.priceOverrideApprovalId ?? null }
            : {}),
          ...(patch.modifiers !== undefined
            ? { modifiers: patch.modifiers.map(this.modifier) }
            : {}),
          ...(patch.seatNumber !== undefined ? { seatNumber: patch.seatNumber } : {}),
          ...(patch.courseNumber !== undefined ? { courseNumber: patch.courseNumber } : {}),
          ...(patch.fulfillmentMode !== undefined
            ? { fulfillmentMode: patch.fulfillmentMode }
            : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        },
        cc,
      ),
      approvalId: gate.approvalId,
      onBehalfOf: approverId,
    }));
  }

  /** Draft: the line is deleted. A placed order voids it instead (see voidLine). */
  async removeLine(orderId: string, lineId: string, opts: CommandOpts): Promise<OrderDto> {
    await this.authorize(orderId, 'orders.create');
    return this.apply(orderId, opts, (before, cc) => ({
      result: domain.removeLine(before, lineId, cc),
    }));
  }

  async voidLine(
    orderId: string,
    lineId: string,
    body: VoidLine,
    opts: CommandOpts,
  ): Promise<OrderDto> {
    const loc = await this.locate(orderId);
    const scope: Scope = { kind: 'location', id: loc.locationId };
    const gate = await this.gate.resolve({
      permission: 'orders.line.void',
      scope,
      approvalId: body.approvalId,
      payload: { permission: 'orders.line.void', orderId, orderLineId: lineId },
    });
    const probe = await this.probe(orderId);
    const cc = this.commands.make();
    await rules(() =>
      domain.voidLine(
        probe,
        lineId,
        { reason: body.reason, approvalId: gate.approvalId, voidedBy: cc.actorId },
        cc,
      ),
    );
    const approverId = await gate.consume();
    return this.apply(orderId, opts, (before, cc2) => ({
      result: domain.voidLine(
        before,
        lineId,
        { reason: body.reason, approvalId: gate.approvalId, voidedBy: cc2.actorId },
        cc2,
      ),
      approvalId: gate.approvalId,
      onBehalfOf: approverId,
    }));
  }

  // -------------------------------------------------------------------------
  // order details, discounts, charges
  // -------------------------------------------------------------------------

  async update(orderId: string, patch: UpdateOrder, opts: CommandOpts): Promise<OrderDto> {
    await this.authorize(orderId, 'orders.create');
    return this.apply(orderId, opts, (before, cc) => ({
      result: domain.updateDetails(
        before,
        {
          ...patch,
          ...(patch.scheduledFor !== undefined
            ? { scheduledFor: isoOrNull(patch.scheduledFor) }
            : {}),
        } as orders.UpdateDetailsInput,
        cc,
      ),
    }));
  }

  async applyDiscount(orderId: string, body: ApplyDiscount, opts: CommandOpts): Promise<OrderDto> {
    const loc = await this.locate(orderId);
    const scope: Scope = { kind: 'location', id: loc.locationId };
    const probe = await this.probe(orderId);
    const percentAttr = this.discountPercent(probe, body);
    const attributes = { 'orders.discount.max_percent': percentAttr };
    const gate = await this.gate.resolve({
      permission: 'orders.discount.apply',
      scope,
      attributes,
      approvalId: body.approvalId,
      payload: {
        permission: 'orders.discount.apply',
        attributes,
        orderId,
        ...(body.lineId ? { orderLineId: body.lineId } : {}),
      },
    });
    const build = (cc: CommandContext): orders.ApplyDiscountInput => ({
      kind: body.kind ?? 'manual',
      lineId: body.lineId ?? null,
      percent: body.percent ?? null,
      amountMinor: money(body.amountMinor) ?? null,
      description: body.description,
      promotionId: body.promotionId ?? null,
      couponId: body.couponId ?? null,
      approvalId: gate.approvalId,
      appliedBy: cc.actorId,
    });
    const cc = this.commands.make();
    await rules(() => domain.applyDiscount(probe, build(cc), cc));
    const approverId = await gate.consume();
    return this.apply(orderId, opts, (before, cc2) => ({
      result: domain.applyDiscount(before, build(cc2), cc2),
      approvalId: gate.approvalId,
      onBehalfOf: approverId,
    }));
  }

  async removeDiscount(orderId: string, discountId: string, opts: CommandOpts): Promise<OrderDto> {
    const loc = await this.locate(orderId);
    await this.authz.assert('orders.discount.apply', { kind: 'location', id: loc.locationId });
    return this.apply(orderId, opts, (before, cc) => ({
      result: domain.removeDiscount(before, discountId, cc),
    }));
  }

  async addCharge(orderId: string, body: AddCharge, opts: CommandOpts): Promise<OrderDto> {
    await this.authorize(orderId, 'orders.create');
    return this.apply(orderId, opts, (before, cc) => ({
      result: domain.addCharge(
        before,
        {
          kind: body.kind,
          description: body.description,
          amountMinor: money(body.amountMinor) ?? null,
          percent: body.percent ?? null,
          ...(body.taxable !== undefined ? { taxable: body.taxable } : {}),
          checkId: body.checkId ?? null,
        },
        cc,
      ),
    }));
  }

  async removeCharge(orderId: string, chargeId: string, opts: CommandOpts): Promise<OrderDto> {
    await this.authorize(orderId, 'orders.create');
    return this.apply(orderId, opts, (before, cc) => ({
      result: domain.removeCharge(before, chargeId, cc),
    }));
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  async suspend(orderId: string, body: SuspendOrder, opts: CommandOpts): Promise<OrderDto> {
    await this.authorize(orderId, 'orders.create');
    return this.apply(orderId, opts, (before, cc) => ({
      result: domain.suspend(before, { reason: body.reason ?? null }, cc),
    }));
  }

  async resume(orderId: string, opts: CommandOpts): Promise<OrderDto> {
    await this.authorize(orderId, 'orders.create');
    return this.apply(orderId, opts, (before, cc) => ({ result: domain.resume(before, cc) }));
  }

  async place(orderId: string, body: PlaceOrder, opts: CommandOpts): Promise<OrderDto> {
    const loc = await this.authorize(orderId, 'orders.create');
    const isReturn = loc.kind === 'return' || loc.kind === 'exchange';
    let approvalId: string | null = null;
    let approverId: string | null = null;
    if (isReturn) {
      // refunds are limited per role (orders.refund.max_minor); a return owing money back needs the permission or an approval
      const probe = await this.probe(orderId);
      const refund = probe.totalMinor < 0n ? -probe.totalMinor : null;
      const attributes =
        refund === null ? undefined : { 'orders.refund.max_minor': Number(refund) };
      const gate = await this.gate.resolve({
        permission: 'orders.refund.create',
        scope: { kind: 'location', id: loc.locationId },
        ...(attributes ? { attributes } : {}),
        approvalId: body.approvalId,
        payload: {
          permission: 'orders.refund.create',
          ...(attributes ? { attributes } : {}),
          orderId,
        },
      });
      approvalId = gate.approvalId;
      approverId = await gate.consume();
    }
    return this.apply(orderId, opts, async (before, cc, tx) => {
      const facts = await this.locations.find(tx.db, before.locationId);
      if (!facts) throw new NotFoundError();
      // an order created online takes the business date of its placement; an offline order keeps its device date
      const businessDate = before.clientCreatedAt
        ? before.businessDate
        : domain.resolveBusinessDate({
            now: new Date(cc.now),
            timezone: facts.timezone,
            boundary: facts.businessDayBoundary,
          });
      const orderNumber = await this.repo.nextOrderNumber(tx.db, before.locationId, businessDate);
      if (!isReturn) {
        const result = domain.place(before, { orderNumber, businessDate }, cc);
        return { result, emits: [orderEvent('order.placed', result.state)] };
      }
      const source = before.sourceOrderId
        ? await this.repo.find(tx.db, before.sourceOrderId, { lock: true })
        : null;
      if (!source) throw new NotFoundError();
      const placed = domain.placeReturn(before, source, { orderNumber, businessDate }, cc);
      return {
        result: { state: placed.state, events: placed.events },
        approvalId,
        onBehalfOf: approverId,
        emits: [
          orderEvent('order.placed', placed.state),
          orderEvent('order.returned', placed.state, {
            lines: placed.state.lines
              .filter((l) => l.returnOfLineId)
              .map((l) => ({
                lineId: l.id,
                returnOfLineId: l.returnOfLineId,
                quantity: l.quantity,
                totalMinor: l.totalMinor.toString(),
              })),
          }),
        ],
        alsoIn: async (t) => {
          await this.repo.save(t.db, source, placed.source);
          await this.repo.appendEvents(
            t.db,
            source.id,
            placed.sourceEvents,
            this.commands.eventMeta(cc, opts.commandId ?? null),
          );
        },
      };
    });
  }

  async voidOrder(orderId: string, body: VoidOrder, opts: CommandOpts): Promise<OrderDto> {
    const loc = await this.locate(orderId);
    const scope: Scope = { kind: 'location', id: loc.locationId };
    let approvalId: string | null = null;
    let approverId: string | null = null;
    if (loc.status === 'draft') {
      // discarding an unplaced cart is not a void
      await this.authz.assert('orders.create', scope);
    } else {
      const gate = await this.gate.resolve({
        permission: 'orders.void',
        scope,
        approvalId: body.approvalId,
        payload: { permission: 'orders.void', orderId },
      });
      const probe = await this.probe(orderId);
      const cc = this.commands.make();
      await rules(() =>
        domain.voidOrder(
          probe,
          { reason: body.reason, approvalId: gate.approvalId, voidedBy: cc.actorId },
          cc,
        ),
      );
      approvalId = gate.approvalId;
      approverId = await gate.consume();
    }
    return this.apply(orderId, opts, async (before, cc, tx) => {
      const result = domain.voidOrder(
        before,
        { reason: body.reason, approvalId, voidedBy: cc.actorId },
        cc,
      );
      const placed = before.placedAt !== null;
      const base: Outcome = {
        result,
        approvalId,
        onBehalfOf: approverId,
        emits: placed
          ? [
              orderEvent('order.voided', result.state, {
                reason: body.reason,
                previousStatus: before.status,
                approvalId,
              }),
            ]
          : [],
      };
      // a cancelled, placed return gives its units back to the source order
      if (
        (before.kind === 'return' || before.kind === 'exchange') &&
        placed &&
        before.sourceOrderId
      ) {
        const source = await this.repo.find(tx.db, before.sourceOrderId, { lock: true });
        if (source) {
          const released = domain.releaseReturn(before, source, cc);
          return {
            ...base,
            alsoIn: async (t) => {
              await this.repo.save(t.db, source, released.state);
              await this.repo.appendEvents(
                t.db,
                source.id,
                released.events,
                this.commands.eventMeta(cc, opts.commandId ?? null),
              );
            },
          };
        }
      }
      return base;
    });
  }

  // -------------------------------------------------------------------------
  // checks
  // -------------------------------------------------------------------------

  async splitChecks(orderId: string, body: SplitChecks, opts: CommandOpts): Promise<OrderDto> {
    await this.authorize(orderId, 'orders.create');
    return this.apply(orderId, opts, (before, cc) => {
      switch (body.mode) {
        case 'lines':
          return {
            result: domain.splitCheckByLines(
              before,
              {
                fromCheckId: body.fromCheckId,
                lineIds: body.lineIds,
                toCheckId: body.toCheckId ?? null,
                label: body.label ?? null,
              },
              cc,
            ),
          };
        case 'seats':
          return {
            result: domain.splitCheckBySeat(
              before,
              {
                fromCheckId: body.fromCheckId,
                seatNumbers: body.seatNumbers,
                toCheckId: body.toCheckId ?? null,
                label: body.label ?? null,
              },
              cc,
            ),
          };
        case 'share':
          return {
            result: domain.shareLine(
              before,
              {
                lineId: body.lineId,
                ...(body.shares
                  ? {
                      shares: body.shares.map((s) => ({
                        checkId: s.checkId ?? null,
                        label: s.label ?? null,
                        quantity: s.quantity,
                      })),
                    }
                  : {}),
                ...(body.parts !== undefined ? { parts: body.parts } : {}),
                ...(body.checkIds ? { checkIds: body.checkIds } : {}),
              },
              cc,
            ),
          };
      }
    });
  }

  async mergeChecks(orderId: string, body: MergeChecks, opts: CommandOpts): Promise<OrderDto> {
    await this.authorize(orderId, 'orders.create');
    return this.apply(orderId, opts, (before, cc) => ({
      result: domain.mergeChecks(
        before,
        { sourceCheckId: body.sourceCheckId, targetCheckId: body.targetCheckId },
        cc,
      ),
    }));
  }

  // -------------------------------------------------------------------------
  // returns and exchanges
  // -------------------------------------------------------------------------

  /** Build a draft return/exchange order from a completed order's lines; the original order is never touched. */
  async createReturn(
    sourceOrderId: string,
    body: CreateReturn,
    opts: CommandOpts = {},
  ): Promise<OrderDto> {
    const loc = await this.authorize(sourceOrderId, 'orders.refund.create');
    return this.uow.run(async (tx) => {
      if (body.clientOrderRef) {
        const existing = await this.repo.findByClientRef(
          tx.db,
          loc.locationId,
          body.clientOrderRef,
        );
        if (existing) {
          const order = await this.repo.find(tx.db, existing);
          if (order) return toOrderDto(order);
        }
      }
      const source = await this.repo.find(tx.db, sourceOrderId);
      if (!source) throw new NotFoundError();
      const facts = await this.locations.find(tx.db, source.locationId);
      if (!facts) throw new NotFoundError();
      const cc = this.commands.make();
      const businessDate = domain.resolveBusinessDate({
        now: new Date(cc.now),
        clientCreatedAt: body.clientCreatedAt ? new Date(body.clientCreatedAt) : null,
        timezone: facts.timezone,
        boundary: facts.businessDayBoundary,
      });
      const built = await rules(() =>
        domain.buildReturnOrder(
          source,
          {
            kind: body.kind,
            lines: body.lines.map((l) => ({
              sourceLineId: l.sourceLineId,
              quantity: l.quantity,
              reason: l.reason ?? null,
            })),
            reason: body.reason ?? null,
            registerId: body.registerId ?? null,
            deviceId: cc.deviceId ?? null,
            businessDate,
            clientOrderRef: body.clientOrderRef ?? null,
            clientCreatedAt: isoOrNull(body.clientCreatedAt),
            notes: body.notes ?? null,
          },
          cc,
        ),
      );
      await this.committer.commitNew(tx, built.state, built, {
        meta: this.commands.eventMeta(cc, opts.commandId ?? null),
        auditAction: `orders.order.${body.kind}_created`,
      });
      return toOrderDto(built.state);
    });
  }

  // -------------------------------------------------------------------------
  // plumbing
  // -------------------------------------------------------------------------

  private async locate(orderId: string) {
    const loc = await this.uow.read((db) => this.repo.locate(db, orderId));
    if (!loc) throw new NotFoundError();
    return loc;
  }

  /** Where the order is (404 when it is not this tenant's), then the permission at that location. */
  private async authorize(orderId: string, permission: PermissionKey) {
    const loc = await this.locate(orderId);
    await this.authz.assert(permission, { kind: 'location', id: loc.locationId });
    return loc;
  }

  private async probe(orderId: string): Promise<OrderState> {
    const order = await this.uow.read((db) => this.repo.find(db, orderId));
    if (!order) throw new NotFoundError();
    return order;
  }

  /** Lock the order, check If-Match, run the reducer, persist rows + events + audit + outbox in one transaction. */
  private async apply(orderId: string, opts: CommandOpts, reduce: Reduce): Promise<OrderDto> {
    return this.uow.run(async (tx) => {
      const before = await this.repo.find(tx.db, orderId, { lock: true });
      if (!before) throw new NotFoundError();
      if (opts.version !== undefined && opts.version !== before.version)
        throw new VersionConflictError(opts.version, before.version);
      const cc = this.commands.make();
      const outcome = await rules(() => reduce(before, cc, tx));
      await this.committer.commit(tx, before, outcome.result, {
        meta: this.commands.eventMeta(cc, opts.commandId ?? null),
        approvalId: outcome.approvalId ?? null,
        onBehalfOf: outcome.onBehalfOf ?? null,
        emits: outcome.emits ?? [],
      });
      if (outcome.alsoIn) await outcome.alsoIn(tx);
      return toOrderDto(outcome.result.state);
    });
  }

  private resolveLine(
    line: AddOrderLine,
    ctx: { locationId: string; channel: string; at: string },
  ) {
    return rules(async () =>
      this.catalog.resolveVariant(
        {
          tenantId: this.context.require().tenantId ?? '',
          locationId: ctx.locationId,
          channel: ctx.channel,
          at: ctx.at,
        },
        {
          variantId: line.variantId ?? null,
          item: line.item ? { ...line.item } : null,
          unitOfMeasure: line.unitOfMeasure ?? null,
          listPriceMinor: line.listPriceMinor === undefined ? null : BigInt(line.listPriceMinor),
        },
      ),
    );
  }

  private modifier = (
    m: AddOrderLine['modifiers'] extends (infer M)[] | undefined ? M : never,
  ): orders.ModifierInput => ({
    modifierId: m.modifierId ?? null,
    groupName: m.groupName ?? null,
    name: m.name,
    ...(m.kind ? { kind: m.kind } : {}),
    ...(m.quantity !== undefined ? { quantity: m.quantity } : {}),
    ...(m.priceDeltaMinor !== undefined ? { priceDeltaMinor: BigInt(m.priceDeltaMinor) } : {}),
  });

  private lineInput(
    line: AddOrderLine,
    snapshot: orders.VariantSnapshot,
    approvalId: string | null = null,
  ): orders.AddLineInput {
    return {
      snapshot,
      quantity: line.quantity,
      ...(line.unitPriceMinor !== undefined ? { unitPriceMinor: BigInt(line.unitPriceMinor) } : {}),
      ...(line.priceOverrideReason !== undefined
        ? { priceOverrideReason: line.priceOverrideReason }
        : {}),
      ...(approvalId || line.priceOverrideApprovalId
        ? { priceOverrideApprovalId: approvalId ?? line.priceOverrideApprovalId ?? null }
        : {}),
      ...(line.modifiers ? { modifiers: line.modifiers.map(this.modifier) } : {}),
      ...(line.checkId ? { checkId: line.checkId } : {}),
      ...(line.seatNumber !== undefined ? { seatNumber: line.seatNumber } : {}),
      ...(line.courseNumber !== undefined ? { courseNumber: line.courseNumber } : {}),
      ...(line.fulfillmentMode ? { fulfillmentMode: line.fulfillmentMode } : {}),
      ...(line.kitchenStatus !== undefined ? { kitchenStatus: line.kitchenStatus } : {}),
      ...(line.notes !== undefined ? { notes: line.notes } : {}),
      ...(line.metadata ? { metadata: line.metadata } : {}),
      ...(line.parentLineId ? { parentLineId: line.parentLineId } : {}),
    };
  }

  /** orders.price.override (or an approval for this exact override) when the price differs from the list price. */
  private async overrideGate(
    locationId: string,
    orderId: string,
    unitPriceMinor: string | undefined,
    snapshot: orders.VariantSnapshot,
    approvalId: string | undefined,
  ) {
    if (unitPriceMinor === undefined || BigInt(unitPriceMinor) === snapshot.listPriceMinor)
      return { approvalId: null as string | null, consume: async () => null as string | null };
    const category = snapshot.itemSnapshot.categoryPath;
    const attributes = category
      ? { 'orders.price_override.allowed_categories': category }
      : undefined;
    return this.gate.resolve({
      permission: 'orders.price.override',
      scope: { kind: 'location', id: locationId },
      ...(attributes ? { attributes } : {}),
      approvalId,
      payload: {
        permission: 'orders.price.override',
        ...(attributes ? { attributes } : {}),
        orderId,
        variantId: snapshot.variantId,
        unitPriceMinor,
      },
    });
  }

  /** Create-with-lines path: no order yet, so an override needs the permission itself (no approval). */
  private async assertOverrideAllowed(
    scope: Scope,
    line: AddOrderLine,
    snapshot: orders.VariantSnapshot,
  ): Promise<void> {
    if (
      line.unitPriceMinor === undefined ||
      BigInt(line.unitPriceMinor) === snapshot.listPriceMinor
    )
      return;
    const category = snapshot.itemSnapshot.categoryPath;
    await this.authz.assert(
      'orders.price.override',
      scope,
      category ? { 'orders.price_override.allowed_categories': category } : undefined,
    );
  }

  /** The discount as a percent of what it applies to, rounded up, for the orders.discount.max_percent limit. */
  private discountPercent(order: OrderState, body: ApplyDiscount): number {
    if (body.percent !== undefined) return Number(body.percent);
    const amount = BigInt(body.amountMinor ?? '0');
    const line = body.lineId ? order.lines.find((l) => l.id === body.lineId) : undefined;
    const base = line ? domain.lineGrossMinor(line) : order.subtotalMinor;
    if (base <= 0n) return 100;
    const hundredths = (amount * 10_000n + base - 1n) / base; // ceil(amount/base × 10000)
    return Math.min(100, Number(hundredths) / 100);
  }
}
