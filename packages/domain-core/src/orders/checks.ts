import { allocate, allocateEvenly } from '../money/allocate.js';
import { mulDecimal } from '../money/decimal.js';
import {
  assertCheckMutable,
  emptyCheck,
  finish,
  findCheck,
  findLine,
  isPriced,
  modifiersDelta,
} from './aggregate.js';
import type { CommandContext } from './context.js';
import { canonicalQuantity, formatQuantity, parseQuantity, ZERO_QUANTITY } from './quantity.js';
import { assertEditable } from './status.js';
import {
  type Check,
  type OrderCharge,
  type OrderDiscount,
  type OrderLine,
  type OrderState,
  type ReducerResult,
  ruleConflict,
  ruleInvalid,
} from './types.js';

function nextCheckNumber(order: OrderState): number {
  return order.checks.reduce((m, c) => Math.max(m, c.number), 0) + 1;
}

/**
 * A percent charge (service charge) is per check: a check created by a split carries its own copy
 * of the source check's percent charges, so splitting a bill never drops the charge. Fixed charges
 * stay where they were.
 */
function copyPercentCharges(
  order: OrderState,
  fromCheckId: string,
  toCheckId: string,
  ctx: CommandContext,
): OrderState {
  const copies = order.charges
    .filter((c) => c.checkId === fromCheckId && c.percent !== null)
    .map((c) => ({ ...c, id: ctx.newId(), checkId: toCheckId, amountMinor: 0n, taxMinor: 0n }));
  return copies.length === 0 ? order : { ...order, charges: [...order.charges, ...copies] };
}

function descendants(order: OrderState, ids: ReadonlySet<string>): Set<string> {
  const all = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const l of order.lines) {
      if (l.parentLineId && all.has(l.parentLineId) && !all.has(l.id)) {
        all.add(l.id);
        grew = true;
      }
    }
  }
  return all;
}

function destination(
  order: OrderState,
  toCheckId: string | null | undefined,
  fromCheckId: string,
  label: string | null | undefined,
  ctx: CommandContext,
): { order: OrderState; check: Check; created: boolean } {
  if (toCheckId) {
    if (toCheckId === fromCheckId)
      throw ruleInvalid('SPLIT_SAME_CHECK', 'The destination check is the source check');
    return { order, check: assertCheckMutable(order, toCheckId), created: false };
  }
  const check = emptyCheck(ctx.newId(), nextCheckNumber(order), label ?? null);
  const withCheck = { ...order, checks: [...order.checks, check] };
  return { order: copyPercentCharges(withCheck, fromCheckId, check.id, ctx), check, created: true };
}

export interface SplitByLinesInput {
  readonly fromCheckId: string;
  readonly lineIds: readonly string[];
  /** Existing check to receive the lines; absent creates a new one. */
  readonly toCheckId?: string | null;
  readonly label?: string | null;
}

/** Split by item: move whole lines (and their component lines) to another check. */
export function splitCheckByLines(
  order: OrderState,
  input: SplitByLinesInput,
  ctx: CommandContext,
): ReducerResult {
  assertEditable(order);
  assertCheckMutable(order, input.fromCheckId);
  if (input.lineIds.length === 0) throw ruleInvalid('NOTHING_TO_SPLIT', 'Name at least one line');
  for (const id of input.lineIds) {
    const line = findLine(order, id);
    if (line.checkId !== input.fromCheckId || !isPriced(line))
      throw ruleConflict('LINE_NOT_ON_CHECK', 'The line is not a billed line of the source check', {
        lineId: id,
      });
  }
  return moveLines(order, input.fromCheckId, new Set(input.lineIds), input, ctx, 'lines');
}

export interface SplitBySeatInput {
  readonly fromCheckId: string;
  readonly seatNumbers: readonly number[];
  readonly toCheckId?: string | null;
  readonly label?: string | null;
}

/** Split by seat: every billed line with one of the seat numbers moves. */
export function splitCheckBySeat(
  order: OrderState,
  input: SplitBySeatInput,
  ctx: CommandContext,
): ReducerResult {
  assertEditable(order);
  assertCheckMutable(order, input.fromCheckId);
  const seats = new Set(input.seatNumbers);
  const ids = new Set(
    order.lines
      .filter(
        (l) =>
          l.checkId === input.fromCheckId &&
          isPriced(l) &&
          l.seatNumber !== null &&
          seats.has(l.seatNumber),
      )
      .map((l) => l.id),
  );
  if (ids.size === 0) throw ruleInvalid('NOTHING_TO_SPLIT', 'No billed line sits at those seats');
  return moveLines(order, input.fromCheckId, ids, input, ctx, 'seat');
}

function moveLines(
  order: OrderState,
  fromCheckId: string,
  ids: ReadonlySet<string>,
  input: { toCheckId?: string | null; label?: string | null },
  ctx: CommandContext,
  mode: 'lines' | 'seat',
): ReducerResult {
  const moving = descendants(order, ids);
  const dest = destination(order, input.toCheckId, fromCheckId, input.label, ctx);
  const lines = dest.order.lines.map((l) =>
    moving.has(l.id) ? { ...l, checkId: dest.check.id } : l,
  );
  return finish(order, { ...dest.order, lines }, ctx, [
    {
      kind: 'check_split',
      payload: {
        mode,
        fromCheckId,
        toCheckId: dest.check.id,
        createdCheck: dest.created,
        lineIds: [...moving],
      },
    },
  ]);
}

export interface ShareTarget {
  /** Existing check; absent with a label creates a new check; absent without one keeps the original check. */
  readonly checkId?: string | null;
  readonly label?: string | null;
  readonly quantity: string;
}

export interface ShareLineInput {
  readonly lineId: string;
  /** Explicit portions (they must add up to the line's quantity)… */
  readonly shares?: readonly ShareTarget[];
  /** …or an even split into `parts` portions (remainder goes to the first portions). */
  readonly parts?: number;
  /** For `parts`: checks receiving portion 0, 1, …; missing entries create new checks (portion 0 keeps the original check). */
  readonly checkIds?: readonly (string | null)[];
}

/**
 * Shared item: split one line into fractional quantities across checks. The original line becomes
 * the first portion; the others are new lines. Every portion carries a fixed gross allocated from
 * the original gross (largest remainder), so the parts add up to the original amount to the cent.
 */
export function shareLine(
  order: OrderState,
  input: ShareLineInput,
  ctx: CommandContext,
): ReducerResult {
  assertEditable(order);
  const line = findLine(order, input.lineId);
  if (!isPriced(line) || line.status !== 'active')
    throw ruleConflict('LINE_NOT_ACTIVE', `A ${line.status} line cannot be shared`);
  if (parseQuantity(line.returnedQuantity) > 0n)
    throw ruleConflict('LINE_HAS_RETURNS', 'A line with returns cannot be shared');
  assertCheckMutable(order, line.checkId);
  const total = parseQuantity(line.quantity);

  let targets: { checkId: string | null; label: string | null; scaled: bigint }[];
  if (input.shares && input.parts !== undefined)
    throw ruleInvalid('SHARE_INPUT_INVALID', 'Give either shares or parts, not both');
  if (input.shares) {
    targets = input.shares.map((s) => ({
      checkId: s.checkId ?? null,
      label: s.label ?? null,
      scaled: parseQuantity(s.quantity),
    }));
  } else if (input.parts !== undefined) {
    if (!Number.isInteger(input.parts) || input.parts < 2 || input.parts > 50)
      throw ruleInvalid('SHARE_INPUT_INVALID', 'parts must be an integer from 2 to 50');
    const quantities = allocateEvenly(total, input.parts);
    targets = quantities.map((q, i) => ({
      checkId: input.checkIds?.[i] ?? (i === 0 ? line.checkId : null),
      label: null,
      scaled: q,
    }));
  } else throw ruleInvalid('SHARE_INPUT_INVALID', 'Give shares or parts');
  if (targets.length < 2)
    throw ruleInvalid('SHARE_INPUT_INVALID', 'A shared line needs at least two portions');
  if (targets.some((t) => t.scaled <= 0n))
    throw ruleInvalid('SHARE_QUANTITY_INVALID', 'Every portion must be greater than zero');
  const sum = targets.reduce((a, t) => a + t.scaled, 0n);
  if (sum !== total)
    throw ruleInvalid('SHARE_QUANTITY_MISMATCH', 'The portions must add up to the line quantity', {
      quantity: line.quantity,
      portions: formatQuantity(sum),
    });

  // Resolve a check for each portion (creating new checks as needed).
  let working = order;
  const resolved: string[] = [];
  const created: string[] = [];
  for (const [i, t] of targets.entries()) {
    if (t.checkId) {
      if (t.checkId !== line.checkId) assertCheckMutable(working, t.checkId);
      resolved.push(t.checkId);
    } else if (t.label !== null || i > 0) {
      const check = emptyCheck(ctx.newId(), nextCheckNumber(working), t.label);
      working = copyPercentCharges(
        { ...working, checks: [...working.checks, check] },
        line.checkId,
        check.id,
        ctx,
      );
      resolved.push(check.id);
      created.push(check.id);
    } else resolved.push(line.checkId);
  }

  const gross =
    line.grossOverrideMinor ??
    mulDecimal(
      line.unitPriceMinor + modifiersDelta(line),
      { unscaled: total, scale: 4 },
      'HALF_UP',
    );
  const grosses = allocate(
    gross,
    targets.map((t) => t.scaled),
  );

  let seq = working.lines.reduce((m, l) => Math.max(m, l.seq), 0);
  const portions: OrderLine[] = targets.map((t, i) => {
    const base: OrderLine = {
      ...line,
      checkId: resolved[i]!,
      quantity: formatQuantity(t.scaled),
      grossOverrideMinor: grosses[i]!,
      metadata: { ...line.metadata, sharedFromLineId: line.id, sharePortion: i },
    };
    if (i === 0) return base;
    seq += 1;
    return {
      ...base,
      id: ctx.newId(),
      seq,
      returnedQuantity: ZERO_QUANTITY,
      modifiers: line.modifiers.map((m) => ({ ...m, id: ctx.newId() })),
      taxes: [],
      createdAt: ctx.now,
    };
  });

  // Line-level discounts follow the portions. Each becomes a fixed amount (what it resolved to on
  // the whole line) allocated by quantity, so the portions discount exactly what the line did.
  const lineDiscounts = working.discounts.filter((d) => d.orderLineId === line.id);
  const otherDiscounts = working.discounts.filter((d) => d.orderLineId !== line.id);
  const discounts: OrderDiscount[] = [...otherDiscounts];
  for (const d of lineDiscounts) {
    const shares = allocate(
      d.amountMinor,
      targets.map((t) => t.scaled),
    );
    portions.forEach((p, i) => {
      discounts.push({
        ...d,
        id: i === 0 ? d.id : ctx.newId(),
        orderLineId: p.id,
        percent: null,
        amountMinor: shares[i]!,
      });
    });
  }

  const lines = [
    ...working.lines.map((l) => (l.id === line.id ? portions[0]! : l)),
    ...portions.slice(1),
  ];
  return finish(order, { ...working, lines, discounts }, ctx, [
    {
      kind: 'line_shared',
      payload: {
        lineId: line.id,
        quantity: canonicalQuantity(line.quantity),
        portions: portions.map((p) => ({
          lineId: p.id,
          checkId: p.checkId,
          quantity: p.quantity,
          grossMinor: p.grossOverrideMinor!.toString(),
        })),
        createdChecks: created,
      },
    },
  ]);
}

export interface MergeChecksInput {
  readonly sourceCheckId: string;
  readonly targetCheckId: string;
}

/** Merge: every line and charge of the source moves to the target; the source check is voided (empty). */
export function mergeChecks(
  order: OrderState,
  input: MergeChecksInput,
  ctx: CommandContext,
): ReducerResult {
  assertEditable(order);
  if (input.sourceCheckId === input.targetCheckId)
    throw ruleInvalid('MERGE_SAME_CHECK', 'Source and target are the same check');
  const source = assertCheckMutable(order, input.sourceCheckId);
  const target = assertCheckMutable(order, input.targetCheckId);
  const lineIds = order.lines.filter((l) => l.checkId === source.id).map((l) => l.id);
  const targetHas = (c: OrderCharge) =>
    c.percent !== null &&
    order.charges.some(
      (t) =>
        t.checkId === target.id &&
        t.percent === c.percent &&
        t.kind === c.kind &&
        t.description === c.description,
    );
  const chargeIds = order.charges.filter((c) => c.checkId === source.id).map((c) => c.id);
  return finish(
    order,
    {
      ...order,
      lines: order.lines.map((l) => (l.checkId === source.id ? { ...l, checkId: target.id } : l)),
      // The target already carries an identical percent charge: the source's copy would double it.
      charges: order.charges
        .filter((c) => !(c.checkId === source.id && targetHas(c)))
        .map((c) => (c.checkId === source.id ? { ...c, checkId: target.id } : c)),
      checks: order.checks.map((c) =>
        c.id === source.id ? { ...c, status: 'voided' as const } : c,
      ),
    },
    ctx,
    [
      {
        kind: 'check_merged',
        payload: { sourceCheckId: source.id, targetCheckId: target.id, lineIds, chargeIds },
      },
    ],
  );
}

export { findCheck };
