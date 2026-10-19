import { randomUUID } from 'node:crypto';

import { withTenant } from '@pos/db';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTenantFixture } from './fixtures.js';
import { startPostgresWithSchema, type TestPostgres } from './postgres.js';

/** Reference closure computed in TypeScript from a parent map. */
export function computeClosure(parent: ReadonlyMap<string, string | null>): Set<string> {
  const pairs = new Set<string>();
  for (const node of parent.keys()) {
    let current: string | null = node;
    let depth = 0;
    while (current !== null) {
      pairs.add(`${current}>${node}:${depth}`);
      current = parent.get(current) ?? null;
      depth += 1;
    }
  }
  return pairs;
}

function isDescendant(
  parent: ReadonlyMap<string, string | null>,
  node: string,
  candidate: string,
): boolean {
  let current: string | null = candidate;
  while (current !== null) {
    if (current === node) return true;
    current = parent.get(current) ?? null;
  }
  return false;
}

interface Op {
  readonly node: number;
  readonly parent: number | null;
}

const forest = fc.integer({ min: 1, max: 25 }).chain((n) =>
  fc.record({
    inserts: fc.tuple(
      ...Array.from({ length: n }, (_, i) =>
        i === 0 ? fc.constant(null) : fc.option(fc.integer({ min: 0, max: i - 1 }), { nil: null }),
      ),
    ),
    reparents: fc.array(
      fc.record({
        node: fc.integer({ min: 0, max: n - 1 }),
        parent: fc.option(fc.integer({ min: 0, max: n - 1 }), { nil: null }),
      }),
      { maxLength: 40 },
    ),
  }),
);

describe('org_unit_paths closure maintenance (property)', () => {
  let db: TestPostgres;

  beforeAll(async () => {
    db = await startPostgresWithSchema();
  });

  afterAll(async () => {
    await db?.stop();
  });

  it('matches the TypeScript reference after random inserts and reparents; cycles are rejected with 23514', async () => {
    await fc.assert(
      fc.asyncProperty(forest, async ({ inserts, reparents }) => {
        const tenant = await createTenantFixture(db.admin, `prop-${randomUUID().slice(0, 8)}`);
        const ids = inserts.map(() => randomUUID());
        const parent = new Map<string, string | null>();

        await withTenant(db.app, tenant.tenantId, async (c) => {
          for (const [i, p] of inserts.entries()) {
            const parentId = p === null ? null : ids[p]!;
            await c.query(
              "INSERT INTO tenancy.org_units (id, tenant_id, parent_id, kind, code, name) VALUES ($1, $2, $3, 'division', $4, $4)",
              [ids[i], tenant.tenantId, parentId, `n${i}`],
            );
            parent.set(ids[i]!, parentId);
          }
        });

        for (const op of reparents as Op[]) {
          const node = ids[op.node]!;
          const newParent = op.parent === null ? null : ids[op.parent]!;
          const cyclic = newParent !== null && isDescendant(parent, node, newParent);
          const attempt = withTenant(db.app, tenant.tenantId, (c) =>
            c.query('UPDATE tenancy.org_units SET parent_id = $1 WHERE id = $2', [newParent, node]),
          );
          if (cyclic) {
            await expect(attempt).rejects.toMatchObject({ code: '23514' });
          } else {
            await attempt;
            parent.set(node, newParent);
          }
        }

        const rows = await db.admin.query<{
          ancestor_id: string;
          descendant_id: string;
          depth: number;
        }>(
          'SELECT ancestor_id, descendant_id, depth FROM tenancy.org_unit_paths WHERE tenant_id = $1',
          [tenant.tenantId],
        );
        const actual = new Set(
          rows.rows.map((r) => `${r.ancestor_id}>${r.descendant_id}:${r.depth}`),
        );
        expect(actual).toEqual(computeClosure(parent));
      }),
      { numRuns: 25 },
    );
  }, 240_000);
});
