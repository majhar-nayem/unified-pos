import { Injectable } from '@nestjs/common';
import type {
  CreateUnitConversion,
  CreateUnitOfMeasure,
  CursorQuery,
  Page,
  UnitConversionDto,
  UnitOfMeasureDto,
  UpdateUnitOfMeasure,
} from '@pos/contracts';
import { newId, type TenantScopedDb, type TenantUnitOfWork } from '@pos/db';

import {
  AuthorizationService,
  ConflictError,
  NotFoundError,
  UnitOfWork,
} from '../../kernel/public/index.js';
import { type UnitConversionRow, type UnitRow, toUnitConversionDto, toUnitDto } from '../rows.js';
import { emitCatalogChanged } from '../shared/events.js';
import { buildPatch, queryPage } from '../shared/sql.js';

/** Units every tenant starts with (seeded by provisioning). Data, not logic. */
export const DEFAULT_UNITS: readonly CreateUnitOfMeasure[] = [
  { code: 'each', name: 'Each', dimension: 'count' },
  { code: 'kg', name: 'Kilogram', dimension: 'mass' },
  { code: 'g', name: 'Gram', dimension: 'mass' },
  { code: 'l', name: 'Litre', dimension: 'volume' },
  { code: 'ml', name: 'Millilitre', dimension: 'volume' },
  { code: 'm', name: 'Metre', dimension: 'length' },
  { code: 'cm', name: 'Centimetre', dimension: 'length' },
];
export const DEFAULT_CONVERSIONS: readonly CreateUnitConversion[] = [
  { fromUnit: 'kg', toUnit: 'g', factor: '1000' },
  { fromUnit: 'l', toUnit: 'ml', factor: '1000' },
  { fromUnit: 'm', toUnit: 'cm', factor: '100' },
];

@Injectable()
export class UnitsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
  ) {}

  async list(): Promise<UnitOfMeasureDto[]> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read(async (db) =>
      (
        await db.query<UnitRow>(
          'SELECT * FROM catalog.units_of_measure WHERE tenant_id = $1 ORDER BY code',
          [db.tenantId],
        )
      ).map(toUnitDto),
    );
  }

  async create(input: CreateUnitOfMeasure): Promise<UnitOfMeasureDto> {
    await this.authz.assert('catalog.item.manage');
    return this.uow.run(async (uow) => {
      const created = await this.insertRaw(uow, input);
      uow.audit({
        action: 'catalog.unit.created',
        resourceKind: 'unit_of_measure',
        after: created,
      });
      emitCatalogChanged(uow, {
        entity: 'unit_of_measure',
        entityId: uow.tenantId,
        change: 'created',
        detail: { code: input.code },
      });
      return created;
    });
  }

  /** Seed insert (tenant provisioning): no authorization and no per-row audit/outbox entry. */
  async insertRaw(uow: TenantUnitOfWork, input: CreateUnitOfMeasure): Promise<UnitOfMeasureDto> {
    const rows = await uow.db.query<UnitRow>(
      'INSERT INTO catalog.units_of_measure (tenant_id, code, name, dimension) VALUES ($1, $2, $3, $4) RETURNING *',
      [uow.tenantId, input.code, input.name, input.dimension],
    );
    return toUnitDto(rows[0]!);
  }

  async update(code: string, patch: UpdateUnitOfMeasure): Promise<UnitOfMeasureDto> {
    await this.authz.assert('catalog.item.manage');
    return this.uow.run(async (uow) => {
      const before = await this.require(uow.db, code);
      const { set, params } = buildPatch(patch, { name: 'name', dimension: 'dimension' }, 3);
      if (!set) return before;
      const rows = await uow.db.query<UnitRow>(
        `UPDATE catalog.units_of_measure SET ${set} WHERE tenant_id = $1 AND code = $2 RETURNING *`,
        [uow.tenantId, code, ...params],
      );
      const after = toUnitDto(rows[0]!);
      uow.audit({ action: 'catalog.unit.updated', resourceKind: 'unit_of_measure', before, after });
      emitCatalogChanged(uow, {
        entity: 'unit_of_measure',
        entityId: uow.tenantId,
        change: 'updated',
        detail: { code },
      });
      return after;
    });
  }

  async require(db: TenantScopedDb, code: string): Promise<UnitOfMeasureDto> {
    const row = await db.maybeOne<UnitRow>(
      'SELECT * FROM catalog.units_of_measure WHERE tenant_id = $1 AND code = $2',
      [db.tenantId, code],
    );
    if (!row) throw new NotFoundError();
    return toUnitDto(row);
  }

  async codes(db: TenantScopedDb): Promise<Set<string>> {
    const rows = await db.query<{ code: string }>(
      'SELECT code FROM catalog.units_of_measure WHERE tenant_id = $1',
      [db.tenantId],
    );
    return new Set(rows.map((r) => r.code));
  }

  async listConversions(
    query: CursorQuery & { variantId?: string },
  ): Promise<Page<UnitConversionDto>> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read((db) =>
      queryPage<UnitConversionRow, UnitConversionDto>(
        db,
        {
          from: 'catalog.unit_conversions t',
          where: query.variantId ? [{ sql: 't.variant_id = ?', value: query.variantId }] : [],
          cursor: query.cursor,
          limit: query.limit,
        },
        toUnitConversionDto,
      ),
    );
  }

  async createConversion(input: CreateUnitConversion): Promise<UnitConversionDto> {
    await this.authz.assert('catalog.item.manage');
    return this.uow.run(async (uow) => {
      const created = await this.insertConversionRaw(uow, input);
      uow.audit({
        action: 'catalog.unit_conversion.created',
        resourceKind: 'unit_conversion',
        resourceId: created.id,
        after: created,
      });
      emitCatalogChanged(uow, {
        entity: 'unit_conversion',
        entityId: created.id,
        change: 'created',
      });
      return created;
    });
  }

  /** Seed insert (tenant provisioning), see insertRaw. */
  async insertConversionRaw(
    uow: TenantUnitOfWork,
    input: CreateUnitConversion,
  ): Promise<UnitConversionDto> {
    if (input.fromUnit === input.toUnit)
      throw new ConflictError('UNIT_CONVERSION_IDENTITY', 'fromUnit and toUnit must differ');
    const known = await this.codes(uow.db);
    if (!known.has(input.fromUnit) || !known.has(input.toUnit))
      throw new NotFoundError('Unknown unit');
    const rows = await uow.db.query<UnitConversionRow>(
      `INSERT INTO catalog.unit_conversions (id, tenant_id, variant_id, from_unit, to_unit, factor)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [newId(), uow.tenantId, input.variantId ?? null, input.fromUnit, input.toUnit, input.factor],
    );
    return toUnitConversionDto(rows[0]!);
  }

  async deleteConversion(id: string): Promise<void> {
    await this.authz.assert('catalog.item.manage');
    await this.uow.run(async (uow) => {
      const rows = await uow.db.query<UnitConversionRow>(
        'DELETE FROM catalog.unit_conversions WHERE tenant_id = $1 AND id = $2 RETURNING *',
        [uow.tenantId, id],
      );
      if (rows.length === 0) throw new NotFoundError();
      uow.audit({
        action: 'catalog.unit_conversion.deleted',
        resourceKind: 'unit_conversion',
        resourceId: id,
        before: toUnitConversionDto(rows[0]!),
      });
      emitCatalogChanged(uow, { entity: 'unit_conversion', entityId: id, change: 'deleted' });
    });
  }
}
