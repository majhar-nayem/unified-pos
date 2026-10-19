import { Injectable } from '@nestjs/common';
import type { CatalogImportDto, CreateCatalogImport, CursorQuery, Page } from '@pos/contracts';
import { newId, type TenantScopedDb } from '@pos/db';

import {
  AuthorizationService,
  NotFoundError,
  RequestContextService,
  UnitOfWork,
  isOperator,
} from '../../kernel/public/index.js';
import { ItemsService } from '../items/items.service.js';
import { type ImportJobRow, toImportJobDto } from '../rows.js';
import { queryPage } from '../shared/sql.js';
import { toCsv } from './csv.js';
import { type ImportLookups, collectKeys, validateImport } from './validate.js';

export function buildReport(errors: CatalogImportDto['errors']): string {
  return toCsv([
    ['line', 'column', 'code', 'message'],
    ...errors.map((e) => [e.line, e.column, e.code, e.message]),
  ]);
}

/**
 * CSV import of items, variants and barcodes. All-or-nothing and create-only: any row error
 * rejects the whole file (nothing is written), and the job keeps a downloadable validation report.
 */
@Injectable()
export class CatalogImportService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly items: ItemsService,
    private readonly context: RequestContextService,
  ) {}

  async create(input: CreateCatalogImport): Promise<CatalogImportDto> {
    await this.authz.assert('catalog.import');
    const principal = this.context.require().principal;
    const createdBy =
      principal && !isOperator(principal) && principal.kind === 'user' ? principal.subjectId : null;
    const dryRun = input.dryRun ?? false;
    return this.uow.run(async (uow) => {
      const lookups = await this.loadLookups(uow.db, input.content);
      const plan = validateImport(input.content, lookups);
      const rejected = plan.errorCount > 0;
      if (!rejected && !dryRun) {
        for (const planned of plan.items) {
          const item = await this.items.insertItem(uow, {
            kind: planned.kind as never,
            name: planned.name,
            categoryId: planned.categoryId,
            taxClassId: planned.taxClassId,
            soldBy: planned.soldBy as never,
            unitOfMeasure: planned.unitOfMeasure,
            trackInventory: planned.trackInventory,
          });
          for (const variant of planned.variants) {
            await this.items.insertVariant(uow, item, {
              sku: variant.sku,
              name: variant.name,
              optionValues: variant.optionValues,
              isDefault: variant.isDefault,
              defaultPriceMinor: variant.defaultPriceMinor,
              costMinor: variant.costMinor,
              barcodes: variant.barcodes.map((b) => ({
                code: b.code,
                kind: b.kind as never,
                packQuantity: b.packQuantity,
                isPrimary: b.isPrimary,
              })),
            });
          }
        }
      }
      const status = rejected ? 'rejected' : dryRun ? 'validated' : 'applied';
      const summary = {
        rows: plan.rows,
        items: plan.items.length,
        variants: plan.variants,
        barcodes: plan.barcodes,
        errors: plan.errorCount,
      };
      const id = newId();
      const rows = await uow.db.query<ImportJobRow>(
        `INSERT INTO catalog.import_jobs (id, tenant_id, file_name, status, dry_run, summary, errors, report_csv, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9) RETURNING *`,
        [
          id,
          uow.tenantId,
          input.fileName ?? 'import.csv',
          status,
          dryRun,
          JSON.stringify(summary),
          JSON.stringify(plan.errors),
          buildReport(plan.errors),
          createdBy,
        ],
      );
      const job = toImportJobDto(rows[0]!);
      uow.audit({
        action: `catalog.import.${status}`,
        resourceKind: 'catalog_import',
        resourceId: id,
        after: { fileName: job.fileName, status, dryRun, summary },
      });
      return job;
    });
  }

  async list(query: CursorQuery): Promise<Page<CatalogImportDto>> {
    await this.authz.assert('catalog.import');
    return this.uow.read((db) =>
      queryPage<ImportJobRow, CatalogImportDto>(
        db,
        {
          from: 'catalog.import_jobs t',
          cursor: query.cursor,
          limit: query.limit,
          descending: true,
        },
        toImportJobDto,
      ),
    );
  }

  async get(id: string): Promise<CatalogImportDto> {
    await this.authz.assert('catalog.import');
    return this.uow.read(async (db) => toImportJobDto(await this.require(db, id)));
  }

  async report(id: string): Promise<{ csv: string; fileName: string }> {
    await this.authz.assert('catalog.import');
    return this.uow.read(async (db) => {
      const row = await this.require(db, id);
      return { csv: row.report_csv, fileName: `import-${id}-report.csv` };
    });
  }

  private async require(db: TenantScopedDb, id: string): Promise<ImportJobRow> {
    const row = await db.maybeOne<ImportJobRow>(
      'SELECT * FROM catalog.import_jobs WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, id],
    );
    if (!row) throw new NotFoundError();
    return row;
  }

  private async loadLookups(db: TenantScopedDb, csv: string): Promise<ImportLookups> {
    const keys = collectKeys(csv);
    // Sequential on purpose: one client per transaction, queries must not overlap.
    const categories = await db.query<{ code: string; id: string }>(
      'SELECT code, id FROM catalog.categories WHERE tenant_id = $1 AND code IS NOT NULL',
      [db.tenantId],
    );
    const taxClasses = await db.query<{ code: string; id: string }>(
      'SELECT code, id FROM catalog.tax_classes WHERE tenant_id = $1',
      [db.tenantId],
    );
    const units = await db.query<{ code: string }>(
      'SELECT code FROM catalog.units_of_measure WHERE tenant_id = $1',
      [db.tenantId],
    );
    const skus = await db.query<{ sku: string }>(
      'SELECT sku FROM catalog.item_variants WHERE tenant_id = $1 AND sku = ANY($2::text[])',
      [db.tenantId, keys.skus],
    );
    const barcodes = await db.query<{ code: string }>(
      'SELECT code FROM catalog.barcodes WHERE tenant_id = $1 AND code = ANY($2::text[])',
      [db.tenantId, keys.barcodes],
    );
    const tenant = await db.query<{ default_currency: string }>(
      'SELECT default_currency FROM platform.tenants WHERE id = $1',
      [db.tenantId],
    );
    return {
      categoryByCode: new Map(categories.map((c) => [c.code, c.id])),
      taxClassByCode: new Map(taxClasses.map((c) => [c.code, c.id])),
      unitCodes: new Set(units.map((u) => u.code)),
      existingSkus: new Set(skus.map((s) => s.sku)),
      existingBarcodes: new Set(barcodes.map((b) => b.code)),
      currency: (tenant[0]?.default_currency ?? 'AUD').trim(),
    };
  }
}
