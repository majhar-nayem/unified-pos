import { Injectable } from '@nestjs/common';
import type { CouponDto, CouponListQuery, CreateCoupon, Page, UpdateCoupon } from '@pos/contracts';
import { newId, type TenantScopedDb } from '@pos/db';

import {
  AuthorizationService,
  ConflictError,
  NotFoundError,
  UnitOfWork,
  ValidationError,
} from '../kernel/public/index.js';
import { emitPricingChanged } from './events.js';
import { PRICING_PERMISSIONS } from './permissions.js';
import { type CouponRow, toCouponDto } from './rows.js';
import { ScopeAccessService } from './scope-access.service.js';
import { queryPage } from './shared/sql.js';

/** Coupon codes are stored upper-case: the engine matches them case-insensitively. */
export const normaliseCouponCode = (code: string): string => code.trim().toUpperCase();

/**
 * Coupons (pricing.coupons). They have no version column, so concurrency is enforced by the
 * statements themselves: an update only touches an `active` coupon and never lowers `max_uses`
 * below the redemptions already made; the only status change allowed is `void`. Redemption
 * (`uses_count`) belongs to the order slice. A coupon inherits the permission scope of its
 * promotion: managing coupons needs the same reach as managing the promotion.
 */
@Injectable()
export class CouponsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly scopes: ScopeAccessService,
  ) {}

  async list(query: CouponListQuery): Promise<Page<CouponDto>> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.view);
    return this.uow.read((db) =>
      queryPage<CouponRow, CouponDto>(
        db,
        {
          from: 'pricing.coupons t',
          where: [
            ...(query.promotionId ? [{ sql: 't.promotion_id = ?', value: query.promotionId }] : []),
            ...(query.status ? [{ sql: 't.status = ?', value: query.status }] : []),
            ...(query.code ? [{ sql: 't.code = ?', value: normaliseCouponCode(query.code) }] : []),
          ],
          cursor: query.cursor,
          limit: query.limit,
        },
        toCouponDto,
      ),
    );
  }

  async get(id: string): Promise<CouponDto> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.view);
    return this.uow.read(async (db) => toCouponDto(await this.requireRow(db, id)));
  }

  async create(promotionId: string, input: CreateCoupon): Promise<CouponDto> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.manage);
    return this.uow.run(async (uow) => {
      await this.assertCanManage(uow.db, promotionId);
      const rows = await uow.db.query<CouponRow>(
        `INSERT INTO pricing.coupons (id, tenant_id, promotion_id, code, customer_id, max_uses, expires_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, 1), $7) RETURNING *`,
        [
          newId(),
          uow.tenantId,
          promotionId,
          normaliseCouponCode(input.code),
          input.customerId ?? null,
          input.maxUses ?? null,
          input.expiresAt ?? null,
        ],
      );
      const created = toCouponDto(rows[0]!);
      uow.audit({
        action: 'pricing.coupon.created',
        resourceKind: 'coupon',
        resourceId: created.id,
        after: created,
      });
      emitPricingChanged(uow, 'pricing.coupon.changed', {
        aggregateKind: 'coupon',
        aggregateId: created.id,
        entity: 'coupon',
        change: 'created',
        detail: { promotionId },
      });
      return created;
    });
  }

  async update(id: string, patch: UpdateCoupon): Promise<CouponDto> {
    this.authz.assertAnywhere(PRICING_PERMISSIONS.manage);
    return this.uow.run(async (uow) => {
      const before = toCouponDto(await this.requireRow(uow.db, id));
      await this.assertCanManage(uow.db, before.promotionId);
      if (before.status !== 'active') {
        throw new ConflictError(
          'COUPON_NOT_ACTIVE',
          `A ${before.status} coupon can no longer be changed`,
        );
      }
      if (patch.maxUses !== undefined && patch.maxUses < before.usesCount) {
        throw new ValidationError({
          body: { maxUses: `must be at least the ${before.usesCount} redemptions already made` },
        });
      }
      if (
        patch.maxUses === undefined &&
        patch.expiresAt === undefined &&
        patch.status === undefined
      )
        return before;
      const rows = await uow.db.query<CouponRow>(
        `UPDATE pricing.coupons SET
           max_uses = COALESCE($3, max_uses),
           expires_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE expires_at END,
           status = COALESCE($6, status)
         WHERE tenant_id = $1 AND id = $2 AND status = 'active' AND uses_count <= COALESCE($3, max_uses) RETURNING *`,
        [
          uow.tenantId,
          id,
          patch.maxUses ?? null,
          patch.expiresAt !== undefined,
          patch.expiresAt ?? null,
          patch.status ?? null,
        ],
      );
      // The guard failed between our read and the write: someone redeemed or voided it meanwhile.
      if (rows.length === 0)
        throw new ConflictError(
          'COUPON_CHANGED',
          'The coupon changed while it was being updated; reload it',
        );
      const after = toCouponDto(rows[0]!);
      uow.audit({
        action: 'pricing.coupon.updated',
        resourceKind: 'coupon',
        resourceId: id,
        before,
        after,
      });
      emitPricingChanged(uow, 'pricing.coupon.changed', {
        aggregateKind: 'coupon',
        aggregateId: id,
        entity: 'coupon',
        change: 'updated',
        detail: {
          promotionId: after.promotionId,
          ...(patch.status ? { status: patch.status } : {}),
        },
      });
      return after;
    });
  }

  /** Same reach as the promotion: every scope of it must be manageable by the caller. */
  private async assertCanManage(db: TenantScopedDb, promotionId: string): Promise<void> {
    const promotion = await db.maybeOne<{ id: string }>(
      'SELECT id FROM pricing.promotions WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, promotionId],
    );
    if (!promotion) throw new NotFoundError();
    const targets = await db.query<{ scope_kind: string; scope_id: string | null }>(
      'SELECT scope_kind, scope_id FROM pricing.promotion_scopes WHERE tenant_id = $1 AND promotion_id = $2',
      [db.tenantId, promotionId],
    );
    await this.scopes.assertManage(
      db,
      targets.map((t) => ({ scopeKind: t.scope_kind, scopeId: t.scope_id })),
    );
  }

  private async requireRow(db: TenantScopedDb, id: string): Promise<CouponRow> {
    const row = await db.maybeOne<CouponRow>(
      'SELECT * FROM pricing.coupons WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, id],
    );
    if (!row) throw new NotFoundError();
    return row;
  }
}
