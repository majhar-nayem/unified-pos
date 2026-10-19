import { Injectable } from '@nestjs/common';
import type { CursorQuery, ItemAvailabilityDto, Page, PutItemAvailability } from '@pos/contracts';
import { newId } from '@pos/db';

import {
  AuthorizationService,
  NotFoundError,
  RequestContextService,
  UnitOfWork,
  isOperator,
} from '../../kernel/public/index.js';
import { ItemsService } from '../items/items.service.js';
import { type AvailabilityRow, toAvailabilityDto } from '../rows.js';
import { queryPage } from '../shared/sql.js';

/** The 86 list: per-location availability independent of stock (catalog.item_availability). */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly items: ItemsService,
    private readonly context: RequestContextService,
  ) {}

  async list(
    locationId: string,
    query: CursorQuery & { onlyUnavailable?: boolean },
  ): Promise<Page<ItemAvailabilityDto>> {
    await this.authz.assert('catalog.view', { kind: 'location', id: locationId });
    return this.uow.read((db) =>
      queryPage<AvailabilityRow, ItemAvailabilityDto>(
        db,
        {
          from: 'catalog.item_availability t',
          where: [
            { sql: 't.location_id = ?', value: locationId },
            ...(query.onlyUnavailable ? [{ sql: 't.is_available = ?', value: false }] : []),
          ],
          cursor: query.cursor,
          limit: query.limit,
        },
        toAvailabilityDto,
      ),
    );
  }

  /** Upsert by (location, item|variant); emits item.availability.changed. */
  async put(locationId: string, input: PutItemAvailability): Promise<ItemAvailabilityDto> {
    await this.authz.assert('catalog.availability.manage', { kind: 'location', id: locationId });
    const principal = this.context.require().principal;
    const updatedBy =
      principal && !isOperator(principal) && principal.kind === 'user' ? principal.subjectId : null;
    return this.uow.run(async (uow) => {
      const itemId = input.itemId ?? null;
      const variantId = input.variantId ?? null;
      if (itemId) await this.items.requireItem(uow.db, itemId);
      if (variantId) await this.items.requireVariant(uow.db, variantId);
      const location = await uow.db.maybeOne<{ id: string }>(
        'SELECT id FROM tenancy.locations WHERE tenant_id = $1 AND id = $2',
        [uow.tenantId, locationId],
      );
      if (!location) throw new NotFoundError();
      const existing = await uow.db.maybeOne<AvailabilityRow>(
        `SELECT * FROM catalog.item_availability WHERE tenant_id = $1 AND location_id = $2
           AND COALESCE(item_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
           AND COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($4::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
        [uow.tenantId, locationId, itemId, variantId],
      );
      const before = existing ? toAvailabilityDto(existing) : null;
      const id = existing?.id ?? newId();
      const rows = await uow.db.query<AvailabilityRow>(
        `INSERT INTO catalog.item_availability (id, tenant_id, location_id, item_id, variant_id, is_available, snoozed_until, reason, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         ON CONFLICT (location_id, COALESCE(item_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
         DO UPDATE SET is_available = EXCLUDED.is_available, snoozed_until = EXCLUDED.snoozed_until, reason = EXCLUDED.reason,
                       updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING *`,
        [
          id,
          uow.tenantId,
          locationId,
          itemId,
          variantId,
          input.isAvailable,
          input.snoozedUntil ?? null,
          input.reason ?? null,
          updatedBy,
        ],
      );
      const after = toAvailabilityDto(rows[0]!);
      uow.audit({
        action: 'catalog.availability.changed',
        resourceKind: 'item_availability',
        resourceId: after.id,
        before,
        after,
        locationId,
      });
      uow.emit({
        type: 'item.availability.changed',
        aggregateKind: 'item_availability',
        aggregateId: after.id,
        locationId,
        payload: {
          itemId,
          variantId,
          isAvailable: after.isAvailable,
          snoozedUntil: after.snoozedUntil,
          reason: after.reason,
        },
      });
      return after;
    });
  }

  async delete(locationId: string, id: string): Promise<void> {
    await this.authz.assert('catalog.availability.manage', { kind: 'location', id: locationId });
    await this.uow.run(async (uow) => {
      const rows = await uow.db.query<AvailabilityRow>(
        'DELETE FROM catalog.item_availability WHERE tenant_id = $1 AND location_id = $2 AND id = $3 RETURNING *',
        [uow.tenantId, locationId, id],
      );
      if (rows.length === 0) throw new NotFoundError();
      const before = toAvailabilityDto(rows[0]!);
      uow.audit({
        action: 'catalog.availability.cleared',
        resourceKind: 'item_availability',
        resourceId: id,
        before,
        locationId,
      });
      uow.emit({
        type: 'item.availability.changed',
        aggregateKind: 'item_availability',
        aggregateId: id,
        locationId,
        payload: {
          itemId: before.itemId,
          variantId: before.variantId,
          isAvailable: true,
          cleared: true,
        },
      });
    });
  }
}
