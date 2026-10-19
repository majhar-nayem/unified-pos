import { createOrder, type CreateOrderInput } from '../aggregate.js';
import type { CommandContext } from '../context.js';
import { addLine, type AddLineInput } from '../lines.js';
import { StubPricingPort } from '../stubs.js';
import type { OrderState, ReducerResult } from '../types.js';

/** Deterministic context: ids are "id-1", "id-2", …; the clock advances one second per command. */
export function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  let n = 0;
  let t = Date.parse('2026-10-18T03:00:00.000Z');
  return {
    get now() {
      t += 1000;
      return new Date(t).toISOString();
    },
    actorId: 'user-1',
    deviceId: null,
    newId: () => `id-${++n}`,
    pricing: new StubPricingPort(),
    ...overrides,
  } as CommandContext;
}

export function draft(ctx: CommandContext, input: Partial<CreateOrderInput> = {}): OrderState {
  return createOrder(
    {
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      businessDate: '2026-10-18',
      kind: 'retail_sale',
      currency: 'AUD',
      ...input,
    },
    ctx,
  ).state;
}

export function snapshot(name: string, priceMinor: bigint, extra: Record<string, unknown> = {}) {
  return {
    variantId: null,
    itemSnapshot: { name, ...extra },
    unitOfMeasure: 'each',
    listPriceMinor: priceMinor,
  };
}

export function add(
  order: OrderState,
  ctx: CommandContext,
  name: string,
  priceMinor: bigint,
  quantity = '1',
  extra: Partial<AddLineInput> = {},
): ReducerResult {
  return addLine(order, { snapshot: snapshot(name, priceMinor), quantity, ...extra }, ctx);
}

/** Add several lines and return the resulting state. */
export function withLines(
  ctx: CommandContext,
  items: ReadonlyArray<[string, bigint, string?]>,
  input: Partial<CreateOrderInput> = {},
): OrderState {
  let order = draft(ctx, input);
  for (const [name, price, qty] of items) order = add(order, ctx, name, price, qty ?? '1').state;
  return order;
}

/** The database CHECK constraints, restated so every test can assert them. */
export function assertDbInvariants(order: OrderState): void {
  const exclusive = order.pricingMode === 'tax_exclusive';
  const expect = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`invariant broken: ${msg}`);
  };
  expect(
    order.totalMinor ===
      order.subtotalMinor -
        order.discountMinor +
        (exclusive ? order.taxMinor : 0n) +
        order.chargesMinor +
        order.tipMinor +
        order.roundingMinor,
    'orders.total_minor formula',
  );
  let sum = 0n;
  for (const c of order.checks) {
    expect(
      c.totalMinor ===
        c.subtotalMinor -
          c.discountMinor +
          (exclusive ? c.taxMinor : 0n) +
          c.chargesMinor +
          c.tipMinor +
          c.roundingMinor,
      `check ${c.number} total formula`,
    );
    sum += c.totalMinor;
  }
  expect(sum === order.totalMinor, 'order total is the sum of check totals');
  expect(
    order.paidMinor === order.checks.reduce((a, c) => a + c.paidMinor, 0n),
    'paid is the sum of check paid',
  );
  for (const l of order.lines) {
    expect(Number(l.returnedQuantity) <= Number(l.quantity), `line ${l.seq} returned ≤ quantity`);
    expect(Number(l.quantity) > 0, `line ${l.seq} quantity > 0`);
    expect(
      order.checks.some((c) => c.id === l.checkId),
      `line ${l.seq} sits on a check`,
    );
  }
  const seqs = order.lines.map((l) => l.seq);
  expect(new Set(seqs).size === seqs.length, 'line seq is unique');
  const numbers = order.checks.map((c) => c.number);
  expect(new Set(numbers).size === numbers.length, 'check number is unique');
}
