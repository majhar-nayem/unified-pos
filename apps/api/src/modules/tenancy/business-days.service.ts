import { Injectable } from '@nestjs/common';
import type { BusinessDayDto } from '@pos/contracts';
import type { TenantScopedDb } from '@pos/db';
import { businessDate } from '@pos/domain-core';

import {
  AuthorizationService,
  ConflictError,
  NotFoundError,
  RequestContextService,
  UnitOfWork,
  isOperator,
} from '../kernel/public/index.js';
import { type BusinessDayRow, type LocationRow, toBusinessDayDto } from './rows.js';

/** Open/close per location and date; closing is the reporting boundary (docs/02 §3.1). */
@Injectable()
export class BusinessDaysService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly context: RequestContextService,
  ) {}

  async list(locationId: string): Promise<BusinessDayDto[]> {
    await this.authz.assert('tenancy.location.view', { kind: 'location', id: locationId });
    return this.uow.read(async (db) =>
      (
        await db.query<BusinessDayRow>(
          "SELECT *, to_char(business_date, 'YYYY-MM-DD') AS business_date FROM tenancy.business_days WHERE tenant_id = $1 AND location_id = $2 ORDER BY business_date DESC LIMIT 60",
          [db.tenantId, locationId],
        )
      ).map(toBusinessDayDto),
    );
  }

  async open(locationId: string, requestedDate?: string): Promise<BusinessDayDto> {
    await this.authz.assert('tenancy.business_day.open', { kind: 'location', id: locationId });
    return this.uow.run(async (uow) => {
      const location = await requireLocation(uow.db, locationId);
      const date =
        requestedDate ??
        businessDate(new Date(), location.timezone, location.business_day_boundary.slice(0, 5));
      const existing = await uow.db.maybeOne<BusinessDayRow>(
        "SELECT *, to_char(business_date, 'YYYY-MM-DD') AS business_date FROM tenancy.business_days WHERE tenant_id = $1 AND location_id = $2 AND status IN ('open', 'closing')",
        [uow.tenantId, locationId],
      );
      if (existing)
        throw new ConflictError(
          'BUSINESS_DAY_ALREADY_OPEN',
          `Business day ${existing.business_date} is still open`,
          { businessDate: existing.business_date },
        );
      const rows = await uow.db.query<BusinessDayRow>(
        `INSERT INTO tenancy.business_days (tenant_id, location_id, business_date) VALUES ($1, $2, $3)
         RETURNING *, to_char(business_date, 'YYYY-MM-DD') AS business_date`,
        [uow.tenantId, locationId, date],
      );
      const day = toBusinessDayDto(rows[0]!);
      uow.audit({
        action: 'tenancy.business_day.opened',
        resourceKind: 'business_day',
        after: day,
        locationId,
      });
      uow.emit({
        type: 'business_day.opened',
        aggregateKind: 'business_day',
        aggregateId: locationId,
        locationId,
        payload: { businessDate: day.businessDate },
      });
      return day;
    });
  }

  async close(locationId: string, date: string): Promise<BusinessDayDto> {
    await this.authz.assert('tenancy.business_day.close', { kind: 'location', id: locationId });
    const principal = this.context.require().principal;
    const closedBy =
      principal && !isOperator(principal) && principal.kind === 'user' ? principal.subjectId : null;
    return this.uow.run(async (uow) => {
      const before = await uow.db.maybeOne<BusinessDayRow>(
        "SELECT *, to_char(business_date, 'YYYY-MM-DD') AS business_date FROM tenancy.business_days WHERE tenant_id = $1 AND location_id = $2 AND business_date = $3",
        [uow.tenantId, locationId, date],
      );
      if (!before) throw new NotFoundError();
      if (before.status === 'closed')
        throw new ConflictError(
          'BUSINESS_DAY_ALREADY_CLOSED',
          `Business day ${date} is already closed`,
        );
      const rows = await uow.db.query<BusinessDayRow>(
        `UPDATE tenancy.business_days SET status = 'closed', closed_at = now(), closed_by = $4
         WHERE tenant_id = $1 AND location_id = $2 AND business_date = $3
         RETURNING *, to_char(business_date, 'YYYY-MM-DD') AS business_date`,
        [uow.tenantId, locationId, date, closedBy],
      );
      const day = toBusinessDayDto(rows[0]!);
      uow.audit({
        action: 'tenancy.business_day.closed',
        resourceKind: 'business_day',
        before: toBusinessDayDto(before),
        after: day,
        locationId,
      });
      uow.emit({
        type: 'business_day.closed',
        aggregateKind: 'business_day',
        aggregateId: locationId,
        locationId,
        payload: { businessDate: day.businessDate, closedBy },
      });
      return day;
    });
  }
}

async function requireLocation(db: TenantScopedDb, id: string): Promise<LocationRow> {
  const row = await db.maybeOne<LocationRow>(
    'SELECT * FROM tenancy.locations WHERE tenant_id = $1 AND id = $2',
    [db.tenantId, id],
  );
  if (!row) throw new NotFoundError();
  return row;
}
