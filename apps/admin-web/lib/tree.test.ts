import type { OrgUnitDto } from '@pos/contracts';
import { describe, expect, it } from 'vitest';

import { buildTree, descendantIds } from './tree';

const unit = (id: string, parentId: string | null, name = id): OrgUnitDto =>
  ({
    id,
    parentId,
    name,
    kind: 'region',
    code: id,
    tenantId: 't',
    legalEntityId: null,
    reportingBoundary: false,
    status: 'active',
    version: 1,
    createdAt: '',
    updatedAt: '',
  }) as OrgUnitDto;

describe('org tree helpers', () => {
  const units = [
    unit('root', null),
    unit('b', 'root', 'Bravo'),
    unit('a', 'root', 'Alpha'),
    unit('a1', 'a'),
    unit('orphan', 'missing'),
  ];

  it('nests children under parents, sorts by name and treats unknown parents as roots', () => {
    const tree = buildTree(units);
    expect(tree.map((n) => n.unit.id).sort()).toEqual(['orphan', 'root']);
    const root = tree.find((n) => n.unit.id === 'root')!;
    expect(root.children.map((c) => c.unit.id)).toEqual(['a', 'b']);
    expect(root.children[0]!.children.map((c) => c.unit.id)).toEqual(['a1']);
  });

  it('collects a unit and all of its descendants (what a reparent must not offer)', () => {
    expect([...descendantIds(units, 'a')].sort()).toEqual(['a', 'a1']);
    expect([...descendantIds(units, 'root')].sort()).toEqual(['a', 'a1', 'b', 'root']);
    expect([...descendantIds(units, 'b')]).toEqual(['b']);
  });
});
