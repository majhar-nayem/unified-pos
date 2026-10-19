/**
 * Modifier selection validation (docs/01-system-architecture.md §5 catalog: "validate modifier
 * selection"). Pure so the POS app validates offline with the same rules the API enforces.
 */
import { toMinor, type MinorAmountInput } from '../money/money.js';

export interface ModifierSpec {
  readonly id: string;
  readonly status: 'active' | 'archived' | string;
  readonly maxQuantity: number;
  readonly priceDeltaMinor: MinorAmountInput;
}

export interface ModifierGroupOverrides {
  readonly selectionMin?: number;
  readonly selectionMax?: number | null;
  readonly allowRepeat?: boolean;
  readonly modifierPrices?: Readonly<Record<string, MinorAmountInput>>;
}

/** A modifier group as linked to one item (group rules + the item's overrides). */
export interface LinkedModifierGroup {
  readonly id: string;
  readonly status: 'active' | 'archived' | string;
  readonly selectionMin: number;
  readonly selectionMax: number | null;
  readonly allowRepeat: boolean;
  readonly modifiers: readonly ModifierSpec[];
  readonly overrides?: ModifierGroupOverrides;
}

export interface ModifierSelectionInput {
  readonly groupId: string;
  readonly modifierId: string;
  readonly quantity?: number;
}

export type ModifierIssueCode =
  | 'GROUP_NOT_LINKED'
  | 'GROUP_ARCHIVED'
  | 'GROUP_BELOW_MIN'
  | 'GROUP_ABOVE_MAX'
  | 'MODIFIER_UNKNOWN'
  | 'MODIFIER_NOT_IN_GROUP'
  | 'MODIFIER_ARCHIVED'
  | 'REPEAT_NOT_ALLOWED'
  | 'QUANTITY_ABOVE_MAX';

export interface ModifierIssue {
  readonly code: ModifierIssueCode;
  readonly groupId: string | null;
  readonly modifierId: string | null;
  readonly message: string;
}

export interface AcceptedSelection {
  readonly groupId: string;
  readonly modifierId: string;
  readonly quantity: number;
  readonly unitPriceDeltaMinor: bigint;
}

export interface ModifierValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ModifierIssue[];
  /** Σ unit delta × quantity over accepted selections. */
  readonly priceDeltaMinor: bigint;
  readonly selections: readonly AcceptedSelection[];
}

export interface EffectiveGroupRules {
  readonly selectionMin: number;
  readonly selectionMax: number | null;
  readonly allowRepeat: boolean;
}

export function effectiveGroupRules(group: LinkedModifierGroup): EffectiveGroupRules {
  const o = group.overrides ?? {};
  return {
    selectionMin: o.selectionMin ?? group.selectionMin,
    selectionMax: o.selectionMax === undefined ? group.selectionMax : o.selectionMax,
    allowRepeat: o.allowRepeat ?? group.allowRepeat,
  };
}

export function effectiveModifierPrice(group: LinkedModifierGroup, modifier: ModifierSpec): bigint {
  const override = group.overrides?.modifierPrices?.[modifier.id];
  return toMinor(override ?? modifier.priceDeltaMinor);
}

export function validateModifierSelection(
  groups: readonly LinkedModifierGroup[],
  selections: readonly ModifierSelectionInput[],
): ModifierValidationResult {
  const issues: ModifierIssue[] = [];
  const accepted: AcceptedSelection[] = [];
  const byGroup = new Map(groups.map((g) => [g.id, g]));
  const modifierHome = new Map<string, string>();
  for (const g of groups) for (const m of g.modifiers) modifierHome.set(m.id, g.id);

  // Merge repeated (group, modifier) pairs into one quantity so "extra extra cheese" counts as 2.
  const merged = new Map<string, { groupId: string; modifierId: string; quantity: number }>();
  for (const s of selections) {
    const key = `${s.groupId}:${s.modifierId}`;
    const q = Math.max(1, Math.trunc(s.quantity ?? 1));
    const existing = merged.get(key);
    if (existing) existing.quantity += q;
    else merged.set(key, { groupId: s.groupId, modifierId: s.modifierId, quantity: q });
  }

  const countPerGroup = new Map<string, number>();
  for (const s of merged.values()) {
    const group = byGroup.get(s.groupId);
    if (!group) {
      issues.push(
        issue(
          'GROUP_NOT_LINKED',
          s.groupId,
          s.modifierId,
          'Modifier group is not linked to this item',
        ),
      );
      continue;
    }
    if (group.status !== 'active') {
      issues.push(issue('GROUP_ARCHIVED', s.groupId, s.modifierId, 'Modifier group is archived'));
      continue;
    }
    const modifier = group.modifiers.find((m) => m.id === s.modifierId);
    if (!modifier) {
      const home = modifierHome.get(s.modifierId);
      issues.push(
        home
          ? issue(
              'MODIFIER_NOT_IN_GROUP',
              s.groupId,
              s.modifierId,
              'Modifier belongs to another group',
            )
          : issue('MODIFIER_UNKNOWN', s.groupId, s.modifierId, 'Unknown modifier'),
      );
      continue;
    }
    if (modifier.status !== 'active') {
      issues.push(issue('MODIFIER_ARCHIVED', s.groupId, s.modifierId, 'Modifier is archived'));
      continue;
    }
    const rules = effectiveGroupRules(group);
    if (s.quantity > 1 && !rules.allowRepeat) {
      issues.push(
        issue('REPEAT_NOT_ALLOWED', s.groupId, s.modifierId, 'This group does not allow repeats'),
      );
      continue;
    }
    if (s.quantity > modifier.maxQuantity) {
      issues.push(
        issue(
          'QUANTITY_ABOVE_MAX',
          s.groupId,
          s.modifierId,
          `At most ${modifier.maxQuantity} of this modifier`,
        ),
      );
      continue;
    }
    countPerGroup.set(s.groupId, (countPerGroup.get(s.groupId) ?? 0) + s.quantity);
    accepted.push({
      groupId: s.groupId,
      modifierId: s.modifierId,
      quantity: s.quantity,
      unitPriceDeltaMinor: effectiveModifierPrice(group, modifier),
    });
  }

  for (const group of groups) {
    if (group.status !== 'active') continue;
    const rules = effectiveGroupRules(group);
    const count = countPerGroup.get(group.id) ?? 0;
    if (count < rules.selectionMin) {
      issues.push(
        issue(
          'GROUP_BELOW_MIN',
          group.id,
          null,
          `Choose at least ${rules.selectionMin} (got ${count})`,
        ),
      );
    }
    if (rules.selectionMax !== null && count > rules.selectionMax) {
      issues.push(
        issue(
          'GROUP_ABOVE_MAX',
          group.id,
          null,
          `Choose at most ${rules.selectionMax} (got ${count})`,
        ),
      );
    }
  }

  const priceDeltaMinor = accepted.reduce(
    (sum, s) => sum + s.unitPriceDeltaMinor * BigInt(s.quantity),
    0n,
  );
  return { valid: issues.length === 0, issues, priceDeltaMinor, selections: accepted };
}

function issue(
  code: ModifierIssueCode,
  groupId: string | null,
  modifierId: string | null,
  message: string,
): ModifierIssue {
  return { code, groupId, modifierId, message };
}
