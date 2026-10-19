import { assertCheckMutable, finish, findLine } from './aggregate.js';
import type { CommandContext } from './context.js';
import { parseDecimal, pow10 } from '../money/decimal.js';
import { assertEditable } from './status.js';
import {
  type ChargeKind,
  type DiscountKind,
  type OrderCharge,
  type OrderDiscount,
  type OrderState,
  type ReducerResult,
  CHARGE_KINDS,
  DISCOUNT_KINDS,
  ruleConflict,
  ruleInvalid,
  ruleNotFound,
} from './types.js';

export interface ApplyDiscountInput {
  readonly kind?: DiscountKind;
  /** null/absent = order-level. */
  readonly lineId?: string | null;
  readonly percent?: string | null;
  readonly amountMinor?: bigint | null;
  readonly description: string;
  readonly promotionId?: string | null;
  readonly couponId?: string | null;
  readonly approvalId?: string | null;
  readonly appliedBy: string | null;
  readonly trace?: unknown;
}

function assertPercent(percent: string): void {
  const p = parseDecimal(percent);
  if (p.unscaled <= 0n || p.unscaled > 100n * pow10(p.scale) || p.scale > 4)
    throw ruleInvalid(
      'DISCOUNT_PERCENT_INVALID',
      'percent must be above 0 and at most 100 (4 places)',
    );
}

function assertNoPayments(order: OrderState): void {
  if (order.paidMinor !== 0n)
    throw ruleConflict(
      'ORDER_HAS_PAYMENTS',
      'Order-level changes are blocked once money was taken',
      {
        paidMinor: order.paidMinor.toString(),
      },
    );
}

export function applyDiscount(
  order: OrderState,
  input: ApplyDiscountInput,
  ctx: CommandContext,
): ReducerResult {
  assertEditable(order);
  const kind = input.kind ?? 'manual';
  if (!DISCOUNT_KINDS.includes(kind))
    throw ruleInvalid('DISCOUNT_KIND_INVALID', `Unknown discount kind ${kind}`);
  if (!input.description?.trim())
    throw ruleInvalid('DISCOUNT_DESCRIPTION_REQUIRED', 'A discount needs a description');
  const hasPercent = input.percent != null;
  const hasAmount = input.amountMinor != null;
  if (hasPercent === hasAmount)
    throw ruleInvalid('DISCOUNT_VALUE_INVALID', 'Give exactly one of percent or amountMinor');
  if (hasPercent) assertPercent(input.percent!);
  if (hasAmount && input.amountMinor! <= 0n)
    throw ruleInvalid('DISCOUNT_VALUE_INVALID', 'amountMinor must be positive');
  const lineId = input.lineId ?? null;
  if (lineId) {
    const line = findLine(order, lineId);
    if (line.status !== 'active')
      throw ruleConflict('LINE_NOT_ACTIVE', `A ${line.status} line cannot be discounted`);
    if (line.grossOverrideMinor !== null && line.returnOfLineId !== null)
      throw ruleConflict(
        'LINE_AMOUNT_FIXED',
        'A returned line refunds what was paid; it takes no discount',
      );
    assertCheckMutable(order, line.checkId);
  } else {
    assertNoPayments(order);
  }
  const discount: OrderDiscount = {
    id: ctx.newId(),
    orderLineId: lineId,
    kind,
    promotionId: input.promotionId ?? null,
    couponId: input.couponId ?? null,
    description: input.description.trim(),
    percent: hasPercent ? input.percent! : null,
    amountMinor: hasAmount ? input.amountMinor! : 0n,
    approvalId: input.approvalId ?? null,
    appliedBy: input.appliedBy,
    appliedAt: ctx.now,
    trace: input.trace ?? null,
  };
  const result = finish(order, { ...order, discounts: [...order.discounts, discount] }, ctx, []);
  const applied = result.state.discounts.find((d) => d.id === discount.id)!;
  if (applied.amountMinor <= 0n)
    throw ruleInvalid('DISCOUNT_NO_EFFECT', 'There is nothing to discount');
  return {
    state: result.state,
    events: [
      {
        kind: 'discount_applied',
        approvalId: input.approvalId ?? null,
        payload: {
          discountId: discount.id,
          lineId,
          kind,
          percent: discount.percent,
          requestedMinor: hasAmount ? input.amountMinor!.toString() : null,
          appliedMinor: applied.amountMinor.toString(),
          description: discount.description,
        },
      },
    ],
  };
}

export function removeDiscount(
  order: OrderState,
  discountId: string,
  ctx: CommandContext,
): ReducerResult {
  assertEditable(order);
  const discount = order.discounts.find((d) => d.id === discountId);
  if (!discount)
    throw ruleNotFound('DISCOUNT_NOT_FOUND', 'The discount does not exist on this order');
  if (discount.orderLineId) {
    const line = order.lines.find((l) => l.id === discount.orderLineId);
    if (line) assertCheckMutable(order, line.checkId);
  } else assertNoPayments(order);
  return finish(
    order,
    { ...order, discounts: order.discounts.filter((d) => d.id !== discountId) },
    ctx,
    [
      {
        kind: 'discount_removed',
        payload: { discountId, kind: discount.kind, amountMinor: discount.amountMinor.toString() },
      },
    ],
  );
}

export interface AddChargeInput {
  readonly kind: ChargeKind;
  readonly description: string;
  readonly amountMinor?: bigint | null;
  /** Percentage points of the check's net. */
  readonly percent?: string | null;
  readonly taxable?: boolean;
  readonly checkId?: string | null;
  readonly isGratuity?: boolean;
}

export function addCharge(
  order: OrderState,
  input: AddChargeInput,
  ctx: CommandContext,
): ReducerResult {
  assertEditable(order);
  if (!CHARGE_KINDS.includes(input.kind))
    throw ruleInvalid('CHARGE_KIND_INVALID', `Unknown charge kind ${input.kind}`);
  if (!input.description?.trim())
    throw ruleInvalid('CHARGE_DESCRIPTION_REQUIRED', 'A charge needs a description');
  const hasPercent = input.percent != null;
  const hasAmount = input.amountMinor != null;
  if (hasPercent === hasAmount)
    throw ruleInvalid('CHARGE_VALUE_INVALID', 'Give exactly one of percent or amountMinor');
  if (hasPercent) assertPercent(input.percent!);
  if (hasAmount && input.amountMinor! < 0n)
    throw ruleInvalid('CHARGE_VALUE_INVALID', 'amountMinor must not be negative');
  const check = input.checkId
    ? assertCheckMutable(order, input.checkId)
    : [...order.checks]
        .filter((c) => c.status === 'open' && c.paidMinor === 0n)
        .sort((a, b) => a.number - b.number)[0];
  if (!check) throw ruleConflict('NO_OPEN_CHECK', 'There is no open check to charge');
  const charge: OrderCharge = {
    id: ctx.newId(),
    checkId: check.id,
    kind: input.kind,
    description: input.description.trim(),
    amountMinor: hasAmount ? input.amountMinor! : 0n,
    percent: hasPercent ? input.percent! : null,
    taxable: input.taxable ?? true,
    taxMinor: 0n,
    isGratuity: input.isGratuity ?? input.kind === 'gratuity',
  };
  const result = finish(order, { ...order, charges: [...order.charges, charge] }, ctx, []);
  const applied = result.state.charges.find((c) => c.id === charge.id)!;
  return {
    state: result.state,
    events: [
      {
        kind: 'charge_added',
        payload: {
          chargeId: charge.id,
          kind: charge.kind,
          checkId: check.id,
          percent: charge.percent,
          amountMinor: applied.amountMinor.toString(),
        },
      },
    ],
  };
}

export function removeCharge(
  order: OrderState,
  chargeId: string,
  ctx: CommandContext,
): ReducerResult {
  assertEditable(order);
  const charge = order.charges.find((c) => c.id === chargeId);
  if (!charge) throw ruleNotFound('CHARGE_NOT_FOUND', 'The charge does not exist on this order');
  assertCheckMutable(order, charge.checkId);
  return finish(order, { ...order, charges: order.charges.filter((c) => c.id !== chargeId) }, ctx, [
    {
      kind: 'charge_removed',
      payload: { chargeId, kind: charge.kind, amountMinor: charge.amountMinor.toString() },
    },
  ]);
}
