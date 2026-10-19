import { Injectable } from '@nestjs/common';
import {
  type CreatePromotion,
  type CreatePromotionScope,
  PROMOTION_STATUS_TRANSITIONS,
  promotionKindMatchesRules,
  type Page,
  type CursorQuery,
  type PromotionDto,
  type PromotionListQuery,
  type PromotionScopeDto,
  type UpdatePromotion,
} from '@pos/contracts';
import { newId, type TenantScopedDb, type TenantUnitOfWork } from '@pos/db';

import {
  AuthorizationService,
  ConflictError,
  NotFoundError,
  RequestContextService,
  UnitOfWork,
  ValidationError,
  VersionConflictError,
  isOperator,
} from '../kernel/public/index.js';
import { emitPricingChanged } from './events.js';
import { PRICING_PERMISSIONS } from './permissions.js';
import { type PromotionRow, type PromotionScopeRow, toPromotionDto, toScopeDto } from './rows.js';
import { ScopeAccessService, type ScopeTarget } from './scope-access.service.js';
import { buildPatch, queryPage } from './shared/sql.js';

const COLUMNS = {
  code: 'code',
  name: 'name',
  description: 'description',
  kind: 'kind',
  rules: { column: 'rules', json: true },
  priority: 'priority',
  stackGroup: 'stack_group',
  isExclusive: 'is_exclusive',
  requiresCoupon: 'requires_coupon',
  maxUsesTotal: 'max_uses_total',
  maxUsesPerCustomer: 'max_uses_per_customer',
  budgetMinor: 'budget_minor',
  schedule: { column: 'schedule', json: true },
  validFrom: 'valid_from',
  validTo: 'valid_to',
  status: 'status',
} as const;

const SCOPE_FROM = `pricing.promotion_scopes t JOIN pricing.promotions p ON p.tenant_id = t.tenant_id AND p.id = t.promotion_id`;

/**
 * Promotions (docs/01 §7.2 step 3 inputs) and their scopes. `rules` is the validated DSL v1; the
 * engine in @pos/domain-core evaluates it, this service only stores and governs it. Scope rows
 * belong to the promotion aggregate: their writes are conditioned on the promotion's `If-Match`
 * version and bump it. Usage counters (`uses_count`, `spent_minor`) are never writable here; the
 * order slice maintains them.
 */
@Injectable()
export class PromotionsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly scopes: ScopeAccessService,
    private readonly context: RequestContextService,
  ) {}

  async list(query: PromotionListQuery): Promise<Page<PromotionDto>> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.view);
    return this.uow.read((db) =>
      queryPage<PromotionRow, PromotionDto>(
        db,
        {
          from: 'pricing.promotions t',
          where: [
            ...(query.status ? [{ sql: 't.status = ?', value: query.status }] : []),
            ...(query.kind ? [{ sql: 't.kind = ?', value: query.kind }] : []),
            ...(query.activeAt
              ? [
                  { sql: 't.valid_from <= ?::timestamptz', value: query.activeAt },
                  {
                    sql: '(t.valid_to IS NULL OR t.valid_to > ?::timestamptz)',
                    value: query.activeAt,
                  },
                ]
              : []),
          ],
          cursor: query.cursor,
          limit: query.limit,
        },
        toPromotionDto,
      ),
    );
  }

  async get(id: string): Promise<PromotionDto> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.view);
    return this.uow.read(async (db) => toPromotionDto(await this.requireRow(db, id)));
  }

  async create(input: CreatePromotion): Promise<PromotionDto> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.manage);
    return this.uow.run(async (uow) => {
      await this.scopes.assertManage(uow.db, input.scopes ?? []);
      const id = newId();
      const rows = await uow.db.query<PromotionRow>(
        `INSERT INTO pricing.promotions
           (id, tenant_id, code, name, description, kind, rules, priority, stack_group, is_exclusive, requires_coupon,
            max_uses_total, max_uses_per_customer, budget_minor, schedule, valid_from, valid_to, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 100), $9, COALESCE($10, false), COALESCE($11, false),
                 $12, $13, $14, COALESCE($15, '{}'::jsonb), $16, $17, COALESCE($18, 'draft'), $19)
         RETURNING *`,
        [
          id,
          uow.tenantId,
          input.code ?? null,
          input.name,
          input.description ?? null,
          input.kind,
          JSON.stringify(input.rules),
          input.priority ?? null,
          input.stackGroup ?? null,
          input.isExclusive ?? null,
          input.requiresCoupon ?? null,
          input.maxUsesTotal ?? null,
          input.maxUsesPerCustomer ?? null,
          input.budgetMinor ?? null,
          input.schedule ? JSON.stringify(input.schedule) : null,
          input.validFrom,
          input.validTo ?? null,
          input.status ?? null,
          this.actorId(),
        ],
      );
      for (const scope of input.scopes ?? []) {
        await uow.db.query(
          `INSERT INTO pricing.promotion_scopes (id, tenant_id, promotion_id, scope_kind, scope_id, scope_value)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            newId(),
            uow.tenantId,
            id,
            scope.scopeKind,
            scope.scopeId ?? null,
            scope.scopeValue ?? null,
          ],
        );
      }
      const created = toPromotionDto(rows[0]!);
      uow.audit({
        action: 'pricing.promotion.created',
        resourceKind: 'promotion',
        resourceId: id,
        after: { ...created, scopes: input.scopes ?? [] },
      });
      this.emit(uow, created, 'created', 'promotion');
      return created;
    });
  }

  async update(id: string, patch: UpdatePromotion, expectedVersion: number): Promise<PromotionDto> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.manage);
    return this.uow.run(async (uow) => {
      const beforeRow = await this.requireRow(uow.db, id);
      const before = toPromotionDto(beforeRow);
      await this.assertCanEdit(uow.db, id);
      if (patch.status && patch.status !== before.status) {
        const allowed = PROMOTION_STATUS_TRANSITIONS[before.status] ?? [];
        if (!allowed.includes(patch.status)) {
          throw new ConflictError(
            'INVALID_STATUS_TRANSITION',
            `A ${before.status} promotion cannot become ${patch.status}`,
            {
              from: before.status,
              to: patch.status,
              allowed,
            },
          );
        }
      }
      // Cross-field rules need the stored values for whichever side the patch leaves out.
      const kind = patch.kind ?? before.kind;
      const rules = patch.rules ?? before.rules;
      if ((patch.kind || patch.rules) && !promotionKindMatchesRules(kind, rules)) {
        throw new ValidationError({ body: { rules: 'rules.effect.kind must match kind' } });
      }
      const from = patch.validFrom ?? before.validFrom;
      const to = patch.validTo !== undefined ? patch.validTo : before.validTo;
      if (to && Date.parse(from) >= Date.parse(to)) {
        throw new ValidationError({ body: { validTo: 'validFrom must be before validTo' } });
      }
      const { set, params } = buildPatch(patch, COLUMNS, 3);
      if (!set) return before;
      const rows = await uow.db.query<PromotionRow>(
        `UPDATE pricing.promotions SET ${set}, version = version + 1, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND version = ${expectedVersion} RETURNING *`,
        [uow.tenantId, id, ...params],
      );
      if (rows.length === 0) throw new VersionConflictError(expectedVersion, before.version);
      const after = toPromotionDto(rows[0]!);
      uow.audit({
        action: 'pricing.promotion.updated',
        resourceKind: 'promotion',
        resourceId: id,
        before,
        after,
      });
      this.emit(
        uow,
        after,
        'updated',
        'promotion',
        undefined,
        patch.status && patch.status !== before.status ? { status: patch.status } : undefined,
      );
      return after;
    });
  }

  /** Only drafts that never issued a coupon can be deleted; everything else is archived. */
  async remove(id: string, expectedVersion: number): Promise<PromotionDto> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.manage);
    return this.uow.run(async (uow) => {
      const before = toPromotionDto(await this.requireRow(uow.db, id));
      await this.assertCanEdit(uow.db, id);
      if (before.version !== expectedVersion)
        throw new VersionConflictError(expectedVersion, before.version);
      if (before.status !== 'draft') {
        throw new ConflictError(
          'PROMOTION_NOT_DRAFT',
          'Only draft promotions can be deleted; archive it instead',
        );
      }
      const deleted = await uow.db.query(
        'DELETE FROM pricing.promotions WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status = $4 RETURNING id',
        [uow.tenantId, id, expectedVersion, 'draft'],
      );
      if (deleted.length === 0) throw new VersionConflictError(expectedVersion);
      uow.audit({
        action: 'pricing.promotion.deleted',
        resourceKind: 'promotion',
        resourceId: id,
        before,
      });
      this.emit(uow, before, 'deleted', 'promotion');
      return before;
    });
  }

  // ------------------------------------------------------------------- scopes

  async listScopes(promotionId: string, query: CursorQuery): Promise<Page<PromotionScopeDto>> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.view);
    return this.uow.read(async (db) => {
      await this.requireRow(db, promotionId);
      return queryPage<PromotionScopeRow, PromotionScopeDto>(
        db,
        {
          from: SCOPE_FROM,
          select: 't.*, p.version AS promotion_version',
          where: [{ sql: 't.promotion_id = ?', value: promotionId }],
          cursor: query.cursor,
          limit: query.limit,
        },
        toScopeDto,
      );
    });
  }

  async createScope(
    promotionId: string,
    input: CreatePromotionScope,
    expectedVersion: number,
  ): Promise<PromotionScopeDto> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.manage);
    return this.uow.run(async (uow) => {
      await this.requireRow(uow.db, promotionId);
      await this.scopes.assertManage(uow.db, [input]);
      const promotion = await this.bump(uow, promotionId, expectedVersion);
      const rows = await uow.db.query<PromotionScopeRow>(
        `INSERT INTO pricing.promotion_scopes (id, tenant_id, promotion_id, scope_kind, scope_id, scope_value)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *, $7::int AS promotion_version`,
        [
          newId(),
          uow.tenantId,
          promotionId,
          input.scopeKind,
          input.scopeId ?? null,
          input.scopeValue ?? null,
          promotion.version,
        ],
      );
      const created = toScopeDto(rows[0]!);
      uow.audit({
        action: 'pricing.promotion.scope_created',
        resourceKind: 'promotion',
        resourceId: promotionId,
        after: created,
      });
      this.emit(uow, toPromotionDto(promotion), 'updated', 'scope', created.id);
      return created;
    });
  }

  async deleteScope(
    promotionId: string,
    scopeId: string,
    expectedVersion: number,
  ): Promise<PromotionScopeDto> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.manage);
    return this.uow.run(async (uow) => {
      const existing = await uow.db.maybeOne<PromotionScopeRow>(
        `SELECT t.*, p.version AS promotion_version FROM ${SCOPE_FROM} WHERE t.tenant_id = $1 AND t.promotion_id = $2 AND t.id = $3`,
        [uow.tenantId, promotionId, scopeId],
      );
      if (!existing) throw new NotFoundError();
      await this.scopes.assertManage(uow.db, [
        { scopeKind: existing.scope_kind, scopeId: existing.scope_id },
      ]);
      const promotion = await this.bump(uow, promotionId, expectedVersion);
      await uow.db.query(
        'DELETE FROM pricing.promotion_scopes WHERE tenant_id = $1 AND promotion_id = $2 AND id = $3',
        [uow.tenantId, promotionId, scopeId],
      );
      const removed = toScopeDto({ ...existing, promotion_version: promotion.version });
      uow.audit({
        action: 'pricing.promotion.scope_deleted',
        resourceKind: 'promotion',
        resourceId: promotionId,
        before: removed,
      });
      this.emit(uow, toPromotionDto(promotion), 'updated', 'scope', scopeId);
      return removed;
    });
  }

  // ----------------------------------------------------------------- internals

  /** The caller must manage every scope the promotion applies to (tenant level when it has none). */
  private async assertCanEdit(db: TenantScopedDb, promotionId: string): Promise<void> {
    const targets = await db.query<{ scope_kind: string; scope_id: string | null }>(
      'SELECT scope_kind, scope_id FROM pricing.promotion_scopes WHERE tenant_id = $1 AND promotion_id = $2',
      [db.tenantId, promotionId],
    );
    const list: ScopeTarget[] = targets.map((t) => ({
      scopeKind: t.scope_kind,
      scopeId: t.scope_id,
    }));
    await this.scopes.assertManage(db, list);
  }

  private async bump(
    uow: TenantUnitOfWork,
    promotionId: string,
    expectedVersion: number,
  ): Promise<PromotionRow> {
    const rows = await uow.db.query<PromotionRow>(
      `UPDATE pricing.promotions SET version = version + 1, updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
      [uow.tenantId, promotionId, expectedVersion],
    );
    if (rows[0]) return rows[0];
    const current = await this.requireRow(uow.db, promotionId);
    throw new VersionConflictError(expectedVersion, current.version);
  }

  private async requireRow(db: TenantScopedDb, id: string): Promise<PromotionRow> {
    const row = await db.maybeOne<PromotionRow>(
      'SELECT * FROM pricing.promotions WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, id],
    );
    if (!row) throw new NotFoundError();
    return row;
  }

  private actorId(): string | null {
    const principal = this.context.require().principal;
    return principal && !isOperator(principal) ? principal.subjectId : null;
  }

  private emit(
    uow: TenantUnitOfWork,
    promotion: PromotionDto,
    change: 'created' | 'updated' | 'deleted',
    entity: string,
    entityId?: string,
    detail?: Record<string, unknown>,
  ): void {
    emitPricingChanged(uow, 'pricing.promotion.changed', {
      aggregateKind: 'promotion',
      aggregateId: promotion.id,
      version: promotion.version,
      entity,
      ...(entityId ? { entityId } : {}),
      change,
      ...(detail ? { detail } : {}),
    });
  }
}
