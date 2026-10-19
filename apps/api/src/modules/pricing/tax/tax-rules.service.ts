import { Injectable } from '@nestjs/common';
import {
  type CreateTaxRule,
  type Page,
  type TaxResolutionDto,
  type TaxResolveQuery,
  type TaxRuleDto,
  type TaxRuleListQuery,
  type UpdateTaxRule,
} from '@pos/contracts';
import { newId, type TenantScopedDb, type TenantUnitOfWork } from '@pos/db';
import {
  type TaxQuery,
  type TaxResolution,
  type TaxRuleCandidate,
  type TaxRuleResolver,
  resolveTaxRule,
} from '@pos/domain-core';

import {
  AuthorizationService,
  NotFoundError,
  UnitOfWork,
  VersionConflictError,
  ConflictError,
} from '../../kernel/public/index.js';
import { TaxClassesService } from '../../catalog/public/index.js';

interface TaxRuleRow {
  id: string;
  tenant_id: string;
  name: string;
  jurisdiction_country: string;
  jurisdiction_region: string | null;
  tax_class_id: string | null;
  kind: TaxRuleDto['kind'];
  rate: string;
  inclusive_default: boolean;
  compound: boolean;
  priority: number;
  valid_from: string;
  valid_to: string | null;
  version: number;
}

/** pg returns `date` as a local-midnight Date; render it back as the calendar date it was stored as. */
function ymd(value: string | Date): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export function toTaxRuleDto(r: TaxRuleRow): TaxRuleDto {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    jurisdictionCountry: r.jurisdiction_country.trim(),
    jurisdictionRegion: r.jurisdiction_region,
    taxClassId: r.tax_class_id,
    kind: r.kind,
    rate: r.rate,
    inclusiveDefault: r.inclusive_default,
    compound: r.compound,
    priority: r.priority,
    validFrom: ymd(r.valid_from),
    validTo: r.valid_to === null ? null : ymd(r.valid_to),
    version: r.version,
  };
}

export function toCandidate(r: TaxRuleDto): TaxRuleCandidate {
  return {
    id: r.id,
    jurisdictionCountry: r.jurisdictionCountry,
    jurisdictionRegion: r.jurisdictionRegion,
    taxClassId: r.taxClassId,
    rate: r.rate,
    inclusiveDefault: r.inclusiveDefault,
    compound: r.compound,
    priority: r.priority,
    validFrom: r.validFrom,
    validTo: r.validTo,
  };
}

const COLUMNS = {
  name: 'name',
  jurisdictionCountry: 'jurisdiction_country',
  jurisdictionRegion: 'jurisdiction_region',
  taxClassId: 'tax_class_id',
  kind: 'kind',
  rate: 'rate',
  inclusiveDefault: 'inclusive_default',
  compound: 'compound',
  priority: 'priority',
  validFrom: 'valid_from',
  validTo: 'valid_to',
} as const;

const SELECT = 'SELECT * FROM pricing.tax_rules';

@Injectable()
export class TaxRulesService implements TaxRuleResolver {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly taxClasses: TaxClassesService,
  ) {}

  async list(query: TaxRuleListQuery): Promise<Page<TaxRuleDto>> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read(async (db) => {
      const params: unknown[] = [db.tenantId];
      const clauses = ['tenant_id = $1'];
      if (query.jurisdictionCountry) {
        params.push(query.jurisdictionCountry);
        clauses.push(`jurisdiction_country = $${params.length}`);
      }
      if (query.taxClassId) {
        params.push(query.taxClassId);
        clauses.push(`tax_class_id = $${params.length}`);
      }
      if (query.cursor) {
        params.push(query.cursor);
        clauses.push(`id > $${params.length}`);
      }
      const rows = await db.query<TaxRuleRow>(
        `${SELECT} WHERE ${clauses.join(' AND ')} ORDER BY id LIMIT ${query.limit + 1}`,
        params,
      );
      const page = rows.slice(0, query.limit);
      return {
        items: page.map(toTaxRuleDto),
        nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    });
  }

  async get(id: string): Promise<TaxRuleDto> {
    this.authz.assertAnywhere('catalog.view');
    return this.uow.read((db) => this.require(db, id));
  }

  async create(input: CreateTaxRule): Promise<TaxRuleDto> {
    await this.authz.assert('pricing.tax.manage');
    return this.uow.run(async (uow) => {
      const created = await this.insertRaw(uow, input);
      uow.audit({
        action: 'pricing.tax_rule.created',
        resourceKind: 'tax_rule',
        resourceId: created.id,
        after: created,
      });
      uow.emit({
        type: 'catalog.item.changed',
        aggregateKind: 'tax_rule',
        aggregateId: created.id,
        aggregateVersion: 1,
        payload: { entity: 'tax_rule', change: 'created', taxClassId: created.taxClassId },
      });
      return created;
    });
  }

  /** Plain insert, also used by the provisioning seeder (no authorization, no per-row audit/outbox entry). */
  async insertRaw(uow: TenantUnitOfWork, input: CreateTaxRule): Promise<TaxRuleDto> {
    assertDateOrder(input.validFrom, input.validTo ?? null);
    if (input.taxClassId) await this.taxClasses.require(uow.db, input.taxClassId);
    const id = newId();
    const rows = await uow.db.query<TaxRuleRow>(
      `INSERT INTO pricing.tax_rules (id, tenant_id, name, jurisdiction_country, jurisdiction_region, tax_class_id, kind, rate,
         inclusive_default, compound, priority, valid_from, valid_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, COALESCE($9, true), COALESCE($10, false), COALESCE($11, 100), $12::date, $13::date)
       RETURNING *`,
      [
        id,
        uow.tenantId,
        input.name,
        input.jurisdictionCountry,
        input.jurisdictionRegion ?? null,
        input.taxClassId ?? null,
        input.kind,
        input.rate,
        input.inclusiveDefault ?? null,
        input.compound ?? null,
        input.priority ?? null,
        input.validFrom,
        input.validTo ?? null,
      ],
    );
    return toTaxRuleDto(rows[0]!);
  }

  async update(id: string, patch: UpdateTaxRule, expectedVersion: number): Promise<TaxRuleDto> {
    await this.authz.assert('pricing.tax.manage');
    return this.uow.run(async (uow) => {
      const before = await this.require(uow.db, id);
      if (patch.taxClassId) await this.taxClasses.require(uow.db, patch.taxClassId);
      assertDateOrder(
        patch.validFrom ?? before.validFrom,
        patch.validTo === undefined ? before.validTo : patch.validTo,
      );
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [field, column] of Object.entries(COLUMNS)) {
        const value = (patch as Record<string, unknown>)[field];
        if (value === undefined) continue;
        params.push(value);
        const cast =
          column === 'rate'
            ? '::numeric'
            : column === 'valid_from' || column === 'valid_to'
              ? '::date'
              : '';
        sets.push(`${column} = $${params.length + 2}${cast}`);
      }
      if (sets.length === 0) {
        if (before.version !== expectedVersion)
          throw new VersionConflictError(expectedVersion, before.version);
        return before;
      }
      const rows = await uow.db.query<TaxRuleRow>(
        `UPDATE pricing.tax_rules SET ${sets.join(', ')}, version = version + 1
         WHERE tenant_id = $1 AND id = $2 AND version = ${expectedVersion} RETURNING *`,
        [uow.tenantId, id, ...params],
      );
      if (rows.length === 0) throw new VersionConflictError(expectedVersion, before.version);
      const after = toTaxRuleDto(rows[0]!);
      uow.audit({
        action: 'pricing.tax_rule.updated',
        resourceKind: 'tax_rule',
        resourceId: id,
        before,
        after,
      });
      uow.emit({
        type: 'catalog.item.changed',
        aggregateKind: 'tax_rule',
        aggregateId: id,
        aggregateVersion: after.version,
        payload: { entity: 'tax_rule', change: 'updated', taxClassId: after.taxClassId },
      });
      return after;
    });
  }

  async delete(id: string): Promise<void> {
    await this.authz.assert('pricing.tax.manage');
    await this.uow.run(async (uow) => {
      const rows = await uow.db.query<TaxRuleRow>(
        'DELETE FROM pricing.tax_rules WHERE tenant_id = $1 AND id = $2 RETURNING *',
        [uow.tenantId, id],
      );
      if (rows.length === 0) throw new NotFoundError();
      uow.audit({
        action: 'pricing.tax_rule.deleted',
        resourceKind: 'tax_rule',
        resourceId: id,
        before: toTaxRuleDto(rows[0]!),
      });
      uow.emit({
        type: 'catalog.item.changed',
        aggregateKind: 'tax_rule',
        aggregateId: id,
        payload: { entity: 'tax_rule', change: 'deleted' },
      });
    });
  }

  /** `GET /v1/tax/resolve`: the rule the pricing pipeline would use, with the effective rate and mode. */
  async resolveForRequest(query: TaxResolveQuery): Promise<TaxResolutionDto> {
    this.authz.assertAnywhere('catalog.view');
    if (query.taxClassId)
      await this.uow.read((db) => this.taxClasses.require(db, query.taxClassId!));
    const on = query.on ?? new Date().toISOString().slice(0, 10);
    const resolution = await this.resolve({
      country: query.country,
      region: query.region ?? null,
      taxClassId: query.taxClassId ?? null,
      on,
    });
    return {
      query: {
        country: query.country,
        region: query.region ?? null,
        taxClassId: query.taxClassId ?? null,
        on,
      },
      rule: resolution.rule
        ? (resolution.rule as TaxRuleCandidate & { dto: TaxRuleDto }).dto
        : null,
      rate: resolution.rate === '0' ? '0.000000' : resolution.rate,
      inclusive: resolution.inclusive,
      candidates: resolution.ranked.length,
      resolvedAt: new Date().toISOString(),
    };
  }

  /** TaxRuleResolver port: loads the tenant's rules for the jurisdiction and applies the pure resolver. */
  async resolve(query: TaxQuery): Promise<TaxResolution<TaxRuleCandidate & { dto: TaxRuleDto }>> {
    const rules = await this.uow.read(async (db) =>
      (
        await db.query<TaxRuleRow>(`${SELECT} WHERE tenant_id = $1 AND jurisdiction_country = $2`, [
          db.tenantId,
          query.country.toUpperCase(),
        ])
      ).map(toTaxRuleDto),
    );
    return resolveTaxRule(
      rules.map((dto) => ({ ...toCandidate(dto), dto })),
      query,
    );
  }

  async require(db: TenantScopedDb, id: string): Promise<TaxRuleDto> {
    const row = await db.maybeOne<TaxRuleRow>(`${SELECT} WHERE tenant_id = $1 AND id = $2`, [
      db.tenantId,
      id,
    ]);
    if (!row) throw new NotFoundError();
    return toTaxRuleDto(row);
  }
}

function assertDateOrder(from: string, to: string | null): void {
  if (to !== null && to < from)
    throw new ConflictError('TAX_RULE_DATES', 'validTo must not be before validFrom');
}
