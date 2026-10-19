import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Migration manifest. Migrations are hand-written SQL (docs/03-implementation-plan.md §1: Drizzle for
 * queries, raw SQL for migrations). The canonical schema stays in db/schema*.sql at the repo root;
 * migration 0001 applies those three files verbatim, in order.
 *
 * Later migrations are expand-only files under packages/db/migrations/NNNN_<name>.sql.
 */
export interface Migration {
  readonly id: string;
  readonly name: string;
  /** Paths relative to the repository root, applied in order inside one transaction. */
  readonly files: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001',
    name: 'initial_schema',
    files: ['db/schema.sql', 'db/schema_part2.sql', 'db/schema_part3.sql'],
  },
  {
    id: '0002',
    name: 'f1_tenancy_identity_audit',
    files: ['packages/db/migrations/0002_f1_tenancy_identity_audit.sql'],
  },
  {
    id: '0003',
    name: 'f2_catalog_tax',
    files: ['packages/db/migrations/0003_f2_catalog_tax.sql'],
  },
];

/** Repository root: this file lives at packages/db/{src,dist}/migrations.{ts,js}. */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
}

export function readMigrationSql(migration: Migration, root: string = repoRoot()): string {
  return migration.files
    .map((file) => `-- >>> ${file}\n${readFileSync(resolve(root, file), 'utf8')}\n`)
    .join('\n');
}
