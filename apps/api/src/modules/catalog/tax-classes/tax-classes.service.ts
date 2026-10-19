import { Injectable } from '@nestjs/common';
import type {
  CreateTaxClass,
  CursorQuery,
  Page,
  TaxClassDto,
  UpdateTaxClass,
} from '@pos/contracts';
import { newId, type TenantScopedDb, type TenantUnitOfWork } from '@pos/db';

import {
  AuthorizationService,
  NotFoundError,
  UnitOfWork,
  VersionConflictError,
} from '../../kernel/public/index.js';
import { type TaxClassRow, toTaxClassDto } from '../rows.js';
import { emitCatalogChanged } from '../shared/events.js';
import { buildPatch, queryPage } from '../shared/sql.js';

const COLUMNS = { code: 'code', name: 'name' } as const;

@Injectable()
export class TaxClassesService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
  ) {}

  async list(query: CursorQuery): Promise<Page<TaxClassDto>> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read((db) =>
      queryPage<TaxClassRow, TaxClassDto>(
        db,
        { from: 'catalog.tax_classes t', cursor: query.cursor, limit: query.limit },
        toTaxClassDto,
      ),
    );
  }

  async get(id: string): Promise<TaxClassDto> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read((db) => this.require(db, id));
  }

  async create(input: CreateTaxClass): Promise<TaxClassDto> {
    await this.authz.assert('pricing.tax.manage');
    return this.uow.run(async (uow) => {
      const created = await this.insertRaw(uow, input);
      uow.audit({
        action: 'catalog.tax_class.created',
        resourceKind: 'tax_class',
        resourceId: created.id,
        after: created,
      });
      emitCatalogChanged(uow, {
        entity: 'tax_class',
        entityId: created.id,
        change: 'created',
        version: 1,
      });
      return created;
    });
  }

  /**
   * Plain insert for tenant provisioning (the seed), inside the provisioning transaction: no authorization
   * check and no per-row audit/outbox entry, because `platform.tenant.provisioned` already records the baseline.
   */
  async insertRaw(uow: TenantUnitOfWork, input: CreateTaxClass): Promise<TaxClassDto> {
    const rows = await uow.db.query<TaxClassRow>(
      'INSERT INTO catalog.tax_classes (id, tenant_id, code, name) VALUES ($1, $2, $3, $4) RETURNING *',
      [newId(), uow.tenantId, input.code, input.name],
    );
    return toTaxClassDto(rows[0]!);
  }

  async update(id: string, patch: UpdateTaxClass, expectedVersion: number): Promise<TaxClassDto> {
    await this.authz.assert('pricing.tax.manage');
    return this.uow.run(async (uow) => {
      const before = await this.require(uow.db, id);
      const { set, params } = buildPatch(patch, COLUMNS, 3);
      if (!set) {
        if (before.version !== expectedVersion)
          throw new VersionConflictError(expectedVersion, before.version);
        return before;
      }
      const rows = await uow.db.query<TaxClassRow>(
        `UPDATE catalog.tax_classes SET ${set}, version = version + 1
         WHERE tenant_id = $1 AND id = $2 AND version = ${expectedVersion} RETURNING *`,
        [uow.tenantId, id, ...params],
      );
      if (rows.length === 0) throw new VersionConflictError(expectedVersion, before.version);
      const after = toTaxClassDto(rows[0]!);
      uow.audit({
        action: 'catalog.tax_class.updated',
        resourceKind: 'tax_class',
        resourceId: id,
        before,
        after,
      });
      emitCatalogChanged(uow, {
        entity: 'tax_class',
        entityId: id,
        change: 'updated',
        version: after.version,
      });
      return after;
    });
  }

  async require(db: TenantScopedDb, id: string): Promise<TaxClassDto> {
    const row = await db.maybeOne<TaxClassRow>(
      'SELECT * FROM catalog.tax_classes WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, id],
    );
    if (!row) throw new NotFoundError();
    return toTaxClassDto(row);
  }

  async findByCode(db: TenantScopedDb, code: string): Promise<TaxClassDto | null> {
    const row = await db.maybeOne<TaxClassRow>(
      'SELECT * FROM catalog.tax_classes WHERE tenant_id = $1 AND code = $2',
      [db.tenantId, code],
    );
    return row ? toTaxClassDto(row) : null;
  }
}
