import { describe, expect, it } from 'vitest';

import { type LinkedModifierGroup, validateModifierSelection } from './modifier-validation.js';

const size: LinkedModifierGroup = {
  id: 'g-size',
  status: 'active',
  selectionMin: 1,
  selectionMax: 1,
  allowRepeat: false,
  modifiers: [
    { id: 'm-small', status: 'active', maxQuantity: 1, priceDeltaMinor: 0 },
    { id: 'm-large', status: 'active', maxQuantity: 1, priceDeltaMinor: '150' },
    { id: 'm-xl', status: 'archived', maxQuantity: 1, priceDeltaMinor: 300n },
  ],
};
const extras: LinkedModifierGroup = {
  id: 'g-extras',
  status: 'active',
  selectionMin: 0,
  selectionMax: 3,
  allowRepeat: true,
  modifiers: [
    { id: 'm-cheese', status: 'active', maxQuantity: 2, priceDeltaMinor: 100 },
    { id: 'm-bacon', status: 'active', maxQuantity: 5, priceDeltaMinor: 250 },
  ],
};
const archived: LinkedModifierGroup = {
  id: 'g-old',
  status: 'archived',
  selectionMin: 1,
  selectionMax: null,
  allowRepeat: false,
  modifiers: [{ id: 'm-old', status: 'active', maxQuantity: 1, priceDeltaMinor: 0 }],
};

const codes = (
  groups: LinkedModifierGroup[],
  selections: Parameters<typeof validateModifierSelection>[1],
) => validateModifierSelection(groups, selections).issues.map((i) => i.code);

describe('validateModifierSelection', () => {
  it('accepts a valid pick and sums the price delta', () => {
    const r = validateModifierSelection(
      [size, extras],
      [
        { groupId: 'g-size', modifierId: 'm-large' },
        { groupId: 'g-extras', modifierId: 'm-cheese', quantity: 2 },
        { groupId: 'g-extras', modifierId: 'm-bacon' },
      ],
    );
    expect(r.valid).toBe(true);
    expect(r.priceDeltaMinor).toBe(150n + 200n + 250n);
    expect(r.selections.map((s) => [s.modifierId, s.quantity, s.unitPriceDeltaMinor])).toEqual([
      ['m-large', 1, 150n],
      ['m-cheese', 2, 100n],
      ['m-bacon', 1, 250n],
    ]);
  });

  it('requires the minimum per group (and reports an empty required group)', () => {
    expect(codes([size, extras], [])).toEqual(['GROUP_BELOW_MIN']);
    const r = validateModifierSelection([size], []);
    expect(r.issues[0]).toMatchObject({ groupId: 'g-size', modifierId: null });
  });

  it('caps the total selections per group', () => {
    expect(
      codes(
        [size, extras],
        [
          { groupId: 'g-size', modifierId: 'm-small' },
          { groupId: 'g-extras', modifierId: 'm-cheese', quantity: 2 },
          { groupId: 'g-extras', modifierId: 'm-bacon', quantity: 2 },
        ],
      ),
    ).toEqual(['GROUP_ABOVE_MAX']);
  });

  it('merges repeated picks of the same modifier and rejects repeats where not allowed', () => {
    expect(
      codes(
        [size],
        [
          { groupId: 'g-size', modifierId: 'm-small' },
          { groupId: 'g-size', modifierId: 'm-small' },
        ],
      ),
    ).toEqual(['REPEAT_NOT_ALLOWED', 'GROUP_BELOW_MIN']);
    expect(
      codes(
        [size],
        [
          { groupId: 'g-size', modifierId: 'm-small' },
          { groupId: 'g-size', modifierId: 'm-large' },
        ],
      ),
    ).toEqual(['GROUP_ABOVE_MAX']);
  });

  it('enforces the modifier max quantity even when repeats are allowed', () => {
    expect(
      codes(
        [size, extras],
        [
          { groupId: 'g-size', modifierId: 'm-small' },
          { groupId: 'g-extras', modifierId: 'm-cheese', quantity: 3 },
        ],
      ),
    ).toEqual(['QUANTITY_ABOVE_MAX']);
  });

  it('rejects unknown, foreign and archived modifiers and groups', () => {
    expect(codes([size], [{ groupId: 'g-size', modifierId: 'm-xl' }])).toEqual([
      'MODIFIER_ARCHIVED',
      'GROUP_BELOW_MIN',
    ]);
    expect(codes([size, extras], [{ groupId: 'g-size', modifierId: 'm-cheese' }])).toEqual([
      'MODIFIER_NOT_IN_GROUP',
      'GROUP_BELOW_MIN',
    ]);
    expect(codes([size], [{ groupId: 'g-size', modifierId: 'nope' }])).toEqual([
      'MODIFIER_UNKNOWN',
      'GROUP_BELOW_MIN',
    ]);
    expect(
      codes(
        [size],
        [
          { groupId: 'g-size', modifierId: 'm-small' },
          { groupId: 'g-other', modifierId: 'm-small' },
        ],
      ),
    ).toEqual(['GROUP_NOT_LINKED']);
    // An archived group is skipped for min/max and its picks are rejected.
    expect(
      codes(
        [size, archived],
        [
          { groupId: 'g-size', modifierId: 'm-small' },
          { groupId: 'g-old', modifierId: 'm-old' },
        ],
      ),
    ).toEqual(['GROUP_ARCHIVED']);
  });

  it('applies per-item overrides for min/max/repeat and modifier prices', () => {
    const relaxed: LinkedModifierGroup = {
      ...size,
      overrides: {
        selectionMin: 0,
        selectionMax: 2,
        allowRepeat: true,
        modifierPrices: { 'm-large': '0' },
      },
    };
    const r = validateModifierSelection(
      [relaxed],
      [{ groupId: 'g-size', modifierId: 'm-large', quantity: 1 }],
    );
    expect(r.valid).toBe(true);
    expect(r.priceDeltaMinor).toBe(0n);
    expect(validateModifierSelection([relaxed], []).valid).toBe(true);
    const twoLarge = validateModifierSelection(
      [relaxed],
      [{ groupId: 'g-size', modifierId: 'm-large', quantity: 2 }],
    );
    // repeats allowed by override, but the modifier's own maxQuantity (1) still applies
    expect(twoLarge.issues.map((i) => i.code)).toEqual(['QUANTITY_ABOVE_MAX']);
  });

  it('treats a missing or zero quantity as one', () => {
    const r = validateModifierSelection(
      [size],
      [{ groupId: 'g-size', modifierId: 'm-small', quantity: 0 }],
    );
    expect(r.valid).toBe(true);
    expect(r.selections[0]?.quantity).toBe(1);
  });
});
