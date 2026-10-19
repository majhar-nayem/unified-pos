import {
  checkSchemaMirror,
  diffSchema,
  formatSchemaDrift,
  mirroredTables,
  type LiveColumn,
} from '@pos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startPostgresWithSchema, type TestPostgres } from './postgres.js';

/** Sprint 0 exit criterion: the Drizzle mirrors in @pos/db match the migrated SQL schema. */
describe('Drizzle schema mirrors against the migrated database', () => {
  let db: TestPostgres;

  beforeAll(async () => {
    db = await startPostgresWithSchema();
  });

  afterAll(async () => {
    await db?.stop();
  });

  it('every mirrored table, column, type, nullability and default matches information_schema', async () => {
    const drift = await checkSchemaMirror(db.admin);
    expect(formatSchemaDrift(drift)).toBe('');
    expect(drift).toEqual([]);
    expect(mirroredTables().length).toBeGreaterThanOrEqual(29);
  });

  it('diffSchema reports each kind of drift (so an empty report means something)', () => {
    const column = (overrides: Partial<LiveColumn>): LiveColumn => ({
      name: 'id',
      type: 'uuid',
      notNull: true,
      hasDefault: true,
      position: 1,
      ...overrides,
    });
    const live = new Map([
      [
        'tenancy.locations',
        new Map([
          ['id', column({})],
          ['name', column({ name: 'name', type: 'text', hasDefault: false, position: 2 })],
          ['extra', column({ name: 'extra', type: 'jsonb', notNull: false, position: 3 })],
        ]),
      ],
    ]);
    const drift = diffSchema(
      [
        {
          schema: 'tenancy',
          name: 'locations',
          columns: [
            { name: 'id', type: 'uuid', notNull: true, hasDefault: false },
            { name: 'name', type: 'citext', notNull: false, hasDefault: false },
            { name: 'gone', type: 'text', notNull: false, hasDefault: false },
          ],
        },
        { schema: 'tenancy', name: 'nope', columns: [] },
      ],
      live,
    );
    expect(drift.map((d) => `${d.kind}:${d.column ?? d.table}`)).toEqual([
      'default_mismatch:id',
      'type_mismatch:name',
      'nullability_mismatch:name',
      'missing_column:gone',
      'unmirrored_column:extra',
      'missing_table:tenancy.nope',
    ]);
  });
});
