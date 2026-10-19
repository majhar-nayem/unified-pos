import type { OrgUnitDto } from '@pos/contracts';

export interface TreeNode {
  unit: OrgUnitDto;
  children: TreeNode[];
}

export function buildTree(units: readonly OrgUnitDto[]): TreeNode[] {
  const byId = new Map(units.map((u) => [u.id, { unit: u, children: [] as TreeNode[] }]));
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.unit.parentId ? byId.get(node.unit.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.unit.name.localeCompare(b.unit.name));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

export function descendantIds(units: readonly OrgUnitDto[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const u of units) {
      if (u.parentId && out.has(u.parentId) && !out.has(u.id)) {
        out.add(u.id);
        grew = true;
      }
    }
  }
  return out;
}
