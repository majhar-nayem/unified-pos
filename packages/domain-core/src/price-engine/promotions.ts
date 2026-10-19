import { allocate, allocateEvenly } from '../money/allocate.js';
import { type Decimal, divRound, mulDecimal, pow10, type RoundingMode } from '../money/decimal.js';
import { toMinor } from '../money/money.js';
import {
  ZERO_DECIMAL,
  addDecimal,
  capAmounts,
  compareDecimal,
  isWholeQuantity,
  minBig,
  nonNegativeMinor,
  parseQuantity,
  percentOf,
  sumBig,
  wholeUnits,
} from './arith.js';
import type {
  BundleComponent,
  ItemSelector,
  PromotionDefinition,
  PromotionEffect,
  PromotionRules,
} from './promotion-types.js';
import { type LocalMomentInfo, scheduleAllows } from './schedule.js';
import type {
  CouponDefinition,
  DraftLine,
  OrderDraft,
  PricingContext,
  PromotionApplication,
  PromotionLineApplication,
  PromotionSkip,
  PromotionSkipReason,
} from './types.js';

/** Mutable per-line state shared by the pipeline steps. */
export interface WorkingLine {
  readonly index: number;
  readonly line: DraftLine;
  readonly quantity: Decimal;
  readonly grossMinor: bigint;
  /** gross − every discount applied so far. */
  remainingMinor: bigint;
  readonly hasManualDiscount: boolean;
}

export interface PromotionOutcome {
  readonly applications: PromotionApplication[];
  readonly skipped: PromotionSkip[];
  /** Per line index, per promotion id: amount applied (for the line trace). */
  readonly perLine: Map<number, { promotionId: string; amountMinor: bigint }[]>;
}

export interface PromotionEvaluationInput {
  readonly lines: WorkingLine[];
  readonly draft: OrderDraft;
  readonly context: PricingContext;
  readonly at: Date;
  readonly moment: LocalMomentInfo;
  readonly mode: RoundingMode;
}

const SUPPORTED_KINDS = new Set([
  'percent_off',
  'amount_off',
  'fixed_price',
  'bogo',
  'multibuy',
  'bundle',
  'threshold',
]);

/**
 * Step 3 of docs/01-system-architecture.md §7.2: filter by scope / schedule / eligibility →
 * sort by (priority asc, createdAt asc, id asc) → apply respecting stack groups, exclusions and
 * exclusivity → record one PromotionApplication per rule with the exact lines and amounts.
 * Every promotion sees the lines as the earlier ones left them, so stacking is sequential.
 */
export function evaluatePromotions(input: PromotionEvaluationInput): PromotionOutcome {
  const { lines, draft, context, at, moment, mode } = input;
  const applications: PromotionApplication[] = [];
  const skipped: PromotionSkip[] = [];
  const perLine = new Map<number, { promotionId: string; amountMinor: bigint }[]>();
  const appliedIds = new Set<string>();
  const takenGroups = new Set<string>();
  const excludedByApplied = new Set<string>();

  const ordered = [...(context.promotions ?? [])].sort(comparePromotions);
  for (const promotion of ordered) {
    const skip = (reason: PromotionSkipReason, detail?: string) =>
      void skipped.push({ promotionId: promotion.id, reason, ...(detail ? { detail } : {}) });

    const eligibility = checkEligibility(promotion, draft, context, at, moment);
    if (eligibility) {
      skip(eligibility.reason, eligibility.detail);
      continue;
    }
    const coupon = promotion.requiresCoupon ? findCoupon(promotion, draft, context, at) : null;
    if (promotion.requiresCoupon && !coupon) {
      skip(hasCouponCode(promotion, draft, context) ? 'coupon_invalid' : 'coupon_required');
      continue;
    }
    if (promotion.stackGroup && takenGroups.has(promotion.stackGroup)) {
      skip('stack_group_taken', promotion.stackGroup);
      continue;
    }
    const excludes = promotion.rules.conditions?.excludesPromotionIds ?? [];
    if (excludedByApplied.has(promotion.id) || excludes.some((id) => appliedIds.has(id))) {
      skip('excluded_by_promotion');
      continue;
    }
    if (promotion.isExclusive && applications.length > 0) {
      skip('exclusive_conflict');
      continue;
    }

    const targets = targetLines(lines, promotion.rules);
    const conditionFailure = checkConditions(promotion.rules, targets, draft, context);
    if (conditionFailure) {
      skip('conditions_not_met', conditionFailure);
      continue;
    }

    let amounts: EffectResult;
    try {
      amounts = computeEffect(promotion.rules.effect, targets, lines, mode);
    } catch (error) {
      skip('invalid_rules', error instanceof Error ? error.message : String(error));
      continue;
    }
    // Never more than what is left on a line.
    const capped = new Map<number, bigint>();
    for (const [index, amount] of amounts.byLine) {
      const line = lines[index]!;
      const value = minBig(amount, line.remainingMinor);
      if (value > 0n) capped.set(index, value);
    }
    let total = sumBig(capped.values());
    if (total <= 0n) {
      skip('no_effect');
      continue;
    }
    if (promotion.budgetMinor !== undefined && promotion.budgetMinor !== null) {
      const remainingBudget = toMinor(promotion.budgetMinor) - toMinor(promotion.spentMinor ?? 0);
      if (remainingBudget <= 0n) {
        skip('budget_exhausted');
        continue;
      }
      if (total > remainingBudget) {
        const indexes = [...capped.keys()];
        const scaled = capAmounts(
          indexes.map((i) => capped.get(i)!),
          remainingBudget,
        );
        capped.clear();
        indexes.forEach((i, n) => {
          if (scaled[n]! > 0n) capped.set(i, scaled[n]!);
        });
        total = sumBig(capped.values());
      }
    }

    const lineApplications: PromotionLineApplication[] = [];
    for (const [index, amount] of [...capped.entries()].sort((a, b) => a[0] - b[0])) {
      const line = lines[index]!;
      line.remainingMinor -= amount;
      const units = amounts.unitsByLine.get(index);
      lineApplications.push({
        lineId: line.line.id,
        amountMinor: amount,
        ...(units !== undefined ? { units } : {}),
      });
      const entries = perLine.get(index) ?? [];
      entries.push({ promotionId: promotion.id, amountMinor: amount });
      perLine.set(index, entries);
    }
    applications.push({
      promotionId: promotion.id,
      code: promotion.code ?? null,
      name: promotion.name,
      kind: promotion.kind,
      stackGroup: promotion.stackGroup ?? null,
      couponId: coupon?.id ?? null,
      amountMinor: total,
      applications: amounts.applications,
      lines: lineApplications,
    });
    appliedIds.add(promotion.id);
    if (promotion.stackGroup) takenGroups.add(promotion.stackGroup);
    for (const id of excludes) excludedByApplied.add(id);
    if (promotion.isExclusive) {
      for (const rest of ordered.slice(ordered.indexOf(promotion) + 1)) {
        skipped.push({ promotionId: rest.id, reason: 'exclusive_conflict' });
      }
      break;
    }
  }
  return { applications, skipped, perLine };
}

export function comparePromotions(a: PromotionDefinition, b: PromotionDefinition): number {
  const pa = a.priority ?? 100;
  const pb = b.priority ?? 100;
  if (pa !== pb) return pa - pb;
  const ca = a.createdAt ?? '';
  const cb = b.createdAt ?? '';
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

function checkEligibility(
  promotion: PromotionDefinition,
  draft: OrderDraft,
  context: PricingContext,
  at: Date,
  moment: LocalMomentInfo,
): { reason: PromotionSkipReason; detail?: string } | null {
  if ((promotion.status ?? 'active') !== 'active') return { reason: 'inactive' };
  const t = at.getTime();
  const from = new Date(promotion.validFrom).getTime();
  if (Number.isNaN(from)) return { reason: 'invalid_rules', detail: 'validFrom' };
  if (from > t) return { reason: 'outside_validity' };
  if (promotion.validTo) {
    const to = new Date(promotion.validTo).getTime();
    if (Number.isNaN(to)) return { reason: 'invalid_rules', detail: 'validTo' };
    if (to <= t) return { reason: 'outside_validity' };
  }
  if (!scheduleAllows(promotion.schedule, moment)) return { reason: 'outside_schedule' };
  if (!scopesReach(promotion, context, draft.customer?.groupIds)) return { reason: 'out_of_scope' };
  const rules = promotion.rules;
  if (!rules || rules.version !== 1 || !rules.effect || !rules.targets) {
    return { reason: 'invalid_rules', detail: 'rules.version' };
  }
  if (!SUPPORTED_KINDS.has(promotion.kind))
    return { reason: 'unsupported', detail: promotion.kind };
  const effectKind = rules.effect.kind;
  const consistent =
    promotion.kind === 'bundle'
      ? effectKind === 'fixed_price' && Array.isArray(rules.effect.bundle)
      : promotion.kind === effectKind;
  if (!consistent)
    return { reason: 'invalid_rules', detail: `kind ${promotion.kind} vs effect ${effectKind}` };
  if (
    promotion.maxUsesTotal !== undefined &&
    promotion.maxUsesTotal !== null &&
    (promotion.usesCount ?? 0) >= promotion.maxUsesTotal
  ) {
    return { reason: 'usage_limit', detail: 'total' };
  }
  if (promotion.maxUsesPerCustomer !== undefined && promotion.maxUsesPerCustomer !== null) {
    const uses = draft.customer?.promotionUses?.[promotion.id] ?? 0;
    if (uses >= promotion.maxUsesPerCustomer) return { reason: 'usage_limit', detail: 'customer' };
  }
  return null;
}

/** No scopes = tenant-wide. Otherwise every scope kind present must match (any value of that kind). */
export function scopesReach(
  promotion: PromotionDefinition,
  context: PricingContext,
  customerGroupIds: readonly string[] = [],
): boolean {
  const scopes = promotion.scopes ?? [];
  if (scopes.length === 0) return true;
  const byKind = new Map<string, boolean>();
  for (const scope of scopes) {
    let matches = false;
    switch (scope.scopeKind) {
      case 'tenant':
        matches = true;
        break;
      case 'org_unit':
        matches = !!scope.scopeId && (context.orgUnitPath ?? []).includes(scope.scopeId);
        break;
      case 'location':
        matches = !!scope.scopeId && scope.scopeId === context.locationId;
        break;
      case 'channel':
        matches = !!scope.scopeValue && scope.scopeValue === context.channel;
        break;
      case 'customer_group':
        matches = !!scope.scopeId && customerGroupIds.includes(scope.scopeId);
        break;
    }
    byKind.set(scope.scopeKind, (byKind.get(scope.scopeKind) ?? false) || matches);
  }
  return [...byKind.values()].every(Boolean);
}

function hasCouponCode(
  promotion: PromotionDefinition,
  draft: OrderDraft,
  context: PricingContext,
): boolean {
  const codes = new Set((draft.couponCodes ?? []).map(normaliseCode));
  return (context.coupons ?? []).some(
    (c) => c.promotionId === promotion.id && codes.has(normaliseCode(c.code)),
  );
}

export function findCoupon(
  promotion: PromotionDefinition,
  draft: OrderDraft,
  context: PricingContext,
  at: Date,
): CouponDefinition | null {
  const codes = new Set((draft.couponCodes ?? []).map(normaliseCode));
  if (codes.size === 0) return null;
  const candidates = (context.coupons ?? [])
    .filter((c) => c.promotionId === promotion.id && codes.has(normaliseCode(c.code)))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const coupon of candidates) {
    if ((coupon.status ?? 'active') !== 'active') continue;
    if (coupon.expiresAt && new Date(coupon.expiresAt).getTime() <= at.getTime()) continue;
    if ((coupon.usesCount ?? 0) >= (coupon.maxUses ?? 1)) continue;
    if (coupon.customerId && coupon.customerId !== draft.customer?.id) continue;
    return coupon;
  }
  return null;
}

function normaliseCode(code: string): string {
  return code.trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// Targets and conditions
// ---------------------------------------------------------------------------

export function selectorMatches(selector: ItemSelector, line: DraftLine): boolean {
  const categories = line.categoryIds ?? [];
  const tags = line.tags ?? [];
  if (selector.excludeVariantIds?.includes(line.variantId)) return false;
  if (line.itemId && selector.excludeItemIds?.includes(line.itemId)) return false;
  if (selector.excludeCategoryIds?.some((c) => categories.includes(c))) return false;
  if (selector.excludeTags?.some((t) => tags.includes(t))) return false;
  if (selector.all) return true;
  if (selector.variantIds?.includes(line.variantId)) return true;
  if (line.itemId && selector.itemIds?.includes(line.itemId)) return true;
  if (selector.categoryIds?.some((c) => categories.includes(c))) return true;
  if (selector.tags?.some((t) => tags.includes(t))) return true;
  return false;
}

function targetLines(lines: readonly WorkingLine[], rules: PromotionRules): WorkingLine[] {
  const allowManual = rules.conditions?.allowWithManualDiscount ?? true;
  return lines.filter(
    (w) =>
      !w.line.promotionsExcluded &&
      (allowManual || !w.hasManualDiscount) &&
      selectorMatches(rules.targets, w.line),
  );
}

function checkConditions(
  rules: PromotionRules,
  targets: readonly WorkingLine[],
  draft: OrderDraft,
  context: PricingContext,
): string | null {
  const c = rules.conditions;
  if (c) {
    if (
      c.channels &&
      c.channels.length > 0 &&
      !(context.channel && c.channels.includes(context.channel))
    ) {
      return 'channel';
    }
    if (c.requiresCustomer && !draft.customer?.id) return 'customer';
    if (c.customerGroupIds && c.customerGroupIds.length > 0) {
      const groups = draft.customer?.groupIds ?? [];
      if (!c.customerGroupIds.some((g) => groups.includes(g))) return 'customer_group';
    }
  }
  if (targets.length === 0) return 'no_targets';
  if (c?.minSubtotalMinor !== undefined) {
    const subtotal = sumBig(targets.map((t) => t.remainingMinor));
    if (subtotal < nonNegativeMinor(c.minSubtotalMinor, 'minSubtotalMinor')) return 'min_subtotal';
  }
  if (c?.minQuantity !== undefined) {
    const total = targets.reduce((acc, t) => addDecimal(acc, t.quantity), ZERO_DECIMAL);
    if (compareDecimal(total, parseQuantity(c.minQuantity, 'minQuantity')) < 0)
      return 'min_quantity';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

interface EffectResult {
  readonly byLine: Map<number, bigint>;
  readonly unitsByLine: Map<number, number>;
  readonly applications: number;
}

interface Unit {
  readonly lineIndex: number;
  readonly amountMinor: bigint;
}

export function computeEffect(
  effect: PromotionEffect,
  targets: readonly WorkingLine[],
  lines: readonly WorkingLine[],
  mode: RoundingMode,
): EffectResult {
  switch (effect.kind) {
    case 'percent_off':
      return percentOff(effect, targets, mode);
    case 'amount_off':
      return amountOff(effect, targets, mode);
    case 'fixed_price':
      return effect.bundle
        ? bundleFixedPrice(effect, effect.bundle, targets, lines, mode)
        : unitFixedPrice(effect, targets, mode);
    case 'bogo':
      return bogo(effect, targets, lines, mode);
    case 'multibuy':
      return multibuy(effect, targets, mode);
    case 'threshold':
      return threshold(effect, targets, mode);
    default: {
      const exhaustive: never = effect;
      throw new RangeError(`Unsupported effect ${String((exhaustive as { kind: string }).kind)}`);
    }
  }
}

function result(
  byLine: Map<number, bigint>,
  applications: number,
  unitsByLine = new Map<number, number>(),
): EffectResult {
  return { byLine, unitsByLine, applications };
}

function percentOff(
  effect: Extract<PromotionEffect, { kind: 'percent_off' }>,
  targets: readonly WorkingLine[],
  mode: RoundingMode,
): EffectResult {
  const amounts = targets.map((t) =>
    percentOf(t.remainingMinor, effect.percent, mode, 'percent_off'),
  );
  const capped =
    effect.maxAmountMinor !== undefined
      ? capAmounts(amounts, nonNegativeMinor(effect.maxAmountMinor, 'maxAmountMinor'))
      : amounts;
  const byLine = new Map<number, bigint>();
  targets.forEach((t, i) => byLine.set(t.index, capped[i]!));
  return result(byLine, 1);
}

function amountOff(
  effect: Extract<PromotionEffect, { kind: 'amount_off' }>,
  targets: readonly WorkingLine[],
  mode: RoundingMode,
): EffectResult {
  const amount = nonNegativeMinor(effect.amountMinor, 'amount_off');
  const byLine = new Map<number, bigint>();
  if (effect.per === 'order') {
    const weights = targets.map((t) => t.remainingMinor);
    const total = minBig(amount, sumBig(weights));
    const shares = allocate(
      total,
      weights.map((w) => (w < 0n ? 0n : w)),
    );
    targets.forEach((t, i) => byLine.set(t.index, shares[i]!));
    return result(byLine, 1);
  }
  for (const t of targets) {
    const value = effect.per === 'unit' ? mulDecimal(amount, t.quantity, mode) : amount;
    byLine.set(t.index, minBig(value, t.remainingMinor));
  }
  return result(byLine, 1);
}

function unitFixedPrice(
  effect: Extract<PromotionEffect, { kind: 'fixed_price' }>,
  targets: readonly WorkingLine[],
  mode: RoundingMode,
): EffectResult {
  const price = nonNegativeMinor(effect.priceMinor, 'fixed_price');
  const byLine = new Map<number, bigint>();
  let applications = 0;
  for (const t of targets) {
    const target = mulDecimal(price, t.quantity, mode);
    if (t.remainingMinor > target) {
      byLine.set(t.index, t.remainingMinor - target);
      applications += 1;
    }
  }
  return result(byLine, applications);
}

/** Expand targeted lines into whole units, most expensive first (ties by line order). */
function unitsOf(targets: readonly WorkingLine[]): Unit[] {
  const units: Unit[] = [];
  for (const t of targets) {
    const count = wholeUnits(t.quantity);
    if (count < 1) continue;
    let amounts: bigint[];
    if (isWholeQuantity(t.quantity)) {
      amounts = allocateEvenly(t.remainingMinor, count);
    } else {
      const perUnit = divRound(
        t.remainingMinor * pow10(t.quantity.scale),
        t.quantity.unscaled,
        'DOWN',
      );
      amounts = Array.from({ length: count }, () => perUnit);
    }
    for (const amountMinor of amounts) units.push({ lineIndex: t.index, amountMinor });
  }
  return units.sort((a, b) => {
    if (a.amountMinor !== b.amountMinor) return a.amountMinor > b.amountMinor ? -1 : 1;
    return a.lineIndex - b.lineIndex;
  });
}

function addTo(map: Map<number, bigint>, index: number, amount: bigint): void {
  map.set(index, (map.get(index) ?? 0n) + amount);
}

function countUnit(map: Map<number, number>, index: number): void {
  map.set(index, (map.get(index) ?? 0) + 1);
}

function bogo(
  effect: Extract<PromotionEffect, { kind: 'bogo' }>,
  targets: readonly WorkingLine[],
  lines: readonly WorkingLine[],
  mode: RoundingMode,
): EffectResult {
  if (!Number.isInteger(effect.buyQuantity) || effect.buyQuantity < 1)
    throw new RangeError('bogo: buyQuantity must be ≥ 1');
  if (!Number.isInteger(effect.getQuantity) || effect.getQuantity < 1)
    throw new RangeError('bogo: getQuantity must be ≥ 1');
  const percent = effect.percentOff ?? '100';
  const byLine = new Map<number, bigint>();
  const unitsByLine = new Map<number, number>();
  const maxApps = effect.maxApplications ?? Number.MAX_SAFE_INTEGER;
  let applications = 0;

  if (effect.getTargets) {
    const getSelector = effect.getTargets;
    const getLines = lines.filter(
      (w) => !w.line.promotionsExcluded && selectorMatches(getSelector, w.line),
    );
    const getIndexes = new Set(getLines.map((w) => w.index));
    const buyUnits = unitsOf(targets.filter((t) => !getIndexes.has(t.index)));
    const getUnits = unitsOf(getLines).reverse(); // cheapest first
    const possible = Math.min(
      Math.floor(buyUnits.length / effect.buyQuantity),
      Math.floor(getUnits.length / effect.getQuantity),
      maxApps,
    );
    for (let app = 0; app < possible; app++) {
      for (let g = 0; g < effect.getQuantity; g++) {
        const unit = getUnits[app * effect.getQuantity + g]!;
        addTo(byLine, unit.lineIndex, percentOf(unit.amountMinor, percent, mode, 'bogo'));
        countUnit(unitsByLine, unit.lineIndex);
      }
      for (let b = 0; b < effect.buyQuantity; b++) {
        countUnit(unitsByLine, buyUnits[app * effect.buyQuantity + b]!.lineIndex);
      }
      applications += 1;
    }
    return result(byLine, applications, unitsByLine);
  }

  const units = unitsOf(targets);
  const groupSize = effect.buyQuantity + effect.getQuantity;
  const groups = Math.min(Math.floor(units.length / groupSize), maxApps);
  for (let g = 0; g < groups; g++) {
    const group = units.slice(g * groupSize, (g + 1) * groupSize);
    group.forEach((unit, i) => {
      countUnit(unitsByLine, unit.lineIndex);
      if (i >= effect.buyQuantity) {
        addTo(byLine, unit.lineIndex, percentOf(unit.amountMinor, percent, mode, 'bogo'));
      }
    });
    applications += 1;
  }
  return result(byLine, applications, unitsByLine);
}

function multibuy(
  effect: Extract<PromotionEffect, { kind: 'multibuy' }>,
  targets: readonly WorkingLine[],
  _mode: RoundingMode,
): EffectResult {
  if (!Number.isInteger(effect.quantity) || effect.quantity < 1)
    throw new RangeError('multibuy: quantity must be ≥ 1');
  const price = nonNegativeMinor(effect.priceMinor, 'multibuy');
  const units = unitsOf(targets);
  const maxApps = effect.maxApplications ?? Number.MAX_SAFE_INTEGER;
  const groups = Math.min(Math.floor(units.length / effect.quantity), maxApps);
  const byLine = new Map<number, bigint>();
  const unitsByLine = new Map<number, number>();
  let applications = 0;
  for (let g = 0; g < groups; g++) {
    const group = units.slice(g * effect.quantity, (g + 1) * effect.quantity);
    const groupTotal = sumBig(group.map((u) => u.amountMinor));
    if (groupTotal <= price) continue;
    const shares = allocate(
      groupTotal - price,
      group.map((u) => u.amountMinor),
    );
    group.forEach((unit, i) => {
      addTo(byLine, unit.lineIndex, shares[i]!);
      countUnit(unitsByLine, unit.lineIndex);
    });
    applications += 1;
  }
  return result(byLine, applications, unitsByLine);
}

function bundleFixedPrice(
  effect: Extract<PromotionEffect, { kind: 'fixed_price' }>,
  components: readonly BundleComponent[],
  targets: readonly WorkingLine[],
  lines: readonly WorkingLine[],
  _mode: RoundingMode,
): EffectResult {
  if (components.length === 0)
    throw new RangeError('fixed_price bundle needs at least one component');
  const price = nonNegativeMinor(effect.priceMinor, 'fixed_price bundle');
  const targetIndexes = new Set(targets.map((t) => t.index));
  // Each component draws from the lines matching its selector among the promotion's targets
  // (a line may match several components: a unit is consumed once).
  const pools = components.map((component) => {
    if (!Number.isInteger(component.quantity) || component.quantity < 1) {
      throw new RangeError('bundle component quantity must be ≥ 1');
    }
    return unitsOf(
      lines.filter((w) => targetIndexes.has(w.index) && selectorMatches(component.targets, w.line)),
    );
  });
  // Track consumption per line so overlapping pools never double-consume a unit.
  const consumed = new Map<number, number>();
  const available = (lineIndex: number) =>
    wholeUnits(lines[lineIndex]!.quantity) - (consumed.get(lineIndex) ?? 0);
  const maxBundles = effect.maxBundles ?? Number.MAX_SAFE_INTEGER;
  const byLine = new Map<number, bigint>();
  const unitsByLine = new Map<number, number>();
  let applications = 0;
  const cursors = pools.map(() => 0);

  for (let b = 0; b < maxBundles; b++) {
    const picked: Unit[] = [];
    const tentative = new Map<number, number>();
    let complete = true;
    for (let c = 0; c < components.length && complete; c++) {
      const pool = pools[c]!;
      let taken = 0;
      while (taken < components[c]!.quantity) {
        const unit = pool[cursors[c]!];
        if (!unit) {
          complete = false;
          break;
        }
        cursors[c]! += 1;
        const used = tentative.get(unit.lineIndex) ?? 0;
        if (available(unit.lineIndex) - used <= 0) continue;
        tentative.set(unit.lineIndex, used + 1);
        picked.push(unit);
        taken += 1;
      }
    }
    if (!complete) break;
    for (const [index, n] of tentative) consumed.set(index, (consumed.get(index) ?? 0) + n);
    const bundleTotal = sumBig(picked.map((u) => u.amountMinor));
    if (bundleTotal > price) {
      const shares = allocate(
        bundleTotal - price,
        picked.map((u) => u.amountMinor),
      );
      picked.forEach((unit, i) => addTo(byLine, unit.lineIndex, shares[i]!));
      for (const unit of picked) countUnit(unitsByLine, unit.lineIndex);
      applications += 1;
    }
  }
  return result(byLine, applications, unitsByLine);
}

function threshold(
  effect: Extract<PromotionEffect, { kind: 'threshold' }>,
  targets: readonly WorkingLine[],
  mode: RoundingMode,
): EffectResult {
  if (effect.tiers.length === 0) throw new RangeError('threshold needs at least one tier');
  const weights = targets.map((t) => t.remainingMinor);
  const subtotal = sumBig(weights);
  const tiers = effect.tiers
    .map((tier) => ({ tier, min: nonNegativeMinor(tier.minSubtotalMinor, 'threshold tier') }))
    .filter((t) => t.min <= subtotal)
    .sort((a, b) => (a.min === b.min ? 0 : a.min > b.min ? -1 : 1));
  const best = tiers[0];
  const byLine = new Map<number, bigint>();
  if (!best) return result(byLine, 0);
  let amount: bigint;
  if (best.tier.percent !== undefined) {
    amount = percentOf(subtotal, best.tier.percent, mode, 'threshold');
  } else if (best.tier.amountMinor !== undefined) {
    amount = minBig(nonNegativeMinor(best.tier.amountMinor, 'threshold tier'), subtotal);
  } else {
    throw new RangeError('threshold tier needs percent or amountMinor');
  }
  if (amount <= 0n) return result(byLine, 0);
  const shares = allocate(
    amount,
    weights.map((w) => (w < 0n ? 0n : w)),
  );
  targets.forEach((t, i) => byLine.set(t.index, shares[i]!));
  return result(byLine, 1);
}
