import { Injectable } from '@nestjs/common';
import type { CreateLegalEntity, UpdateLegalEntity } from '@pos/contracts';
import { newId, type TenantScopedDb } from '@pos/db';

import {
  AuthorizationService,
  NotFoundError,
  UnitOfWork,
  VersionConflictError,
} from '../kernel/public/index.js';
import { type LegalEntityOut, type LegalEntityRow, buildPatch, toLegalEntityDto } from './rows.js';

const COLUMNS = {
  name: 'name',
  countryCode: 'country_code',
  registrationNumber: 'registration_number',
  taxRegistrationNumber: 'tax_registration_number',
  address: 'address',
  receiptLegalText: 'receipt_legal_text',
  status: 'status',
} as const;

@Injectable()
export class LegalEntitiesService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
  ) {}

  async list(): Promise<LegalEntityOut[]> {
    await this.authz.assert('tenancy.org_unit.view');
    return this.uow.read(async (db) =>
      (
        await db.query<LegalEntityRow>(
          'SELECT * FROM tenancy.legal_entities WHERE tenant_id = $1 ORDER BY name',
          [db.tenantId],
        )
      ).map(toLegalEntityDto),
    );
  }

  async get(id: string): Promise<LegalEntityOut> {
    await this.authz.assert('tenancy.org_unit.view');
    return this.uow.read((db) => this.require(db, id));
  }

  async create(input: CreateLegalEntity): Promise<LegalEntityOut> {
    await this.authz.assert('tenancy.legal_entity.manage');
    return this.uow.run(async (uow) => {
      const id = newId();
      const rows = await uow.db.query<LegalEntityRow>(
        `INSERT INTO tenancy.legal_entities (id, tenant_id, name, country_code, registration_number, tax_registration_number, address, receipt_legal_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          id,
          uow.tenantId,
          input.name,
          input.countryCode,
          input.registrationNumber ?? null,
          input.taxRegistrationNumber ?? null,
          JSON.stringify(input.address ?? {}),
          input.receiptLegalText ?? null,
        ],
      );
      const created = toLegalEntityDto(rows[0]!);
      uow.audit({
        action: 'tenancy.legal_entity.created',
        resourceKind: 'legal_entity',
        resourceId: id,
        after: created,
      });
      return created;
    });
  }

  async update(
    id: string,
    patch: UpdateLegalEntity,
    expectedVersion: number,
  ): Promise<LegalEntityOut> {
    await this.authz.assert('tenancy.legal_entity.manage');
    return this.uow.run(async (uow) => {
      const before = await this.require(uow.db, id);
      const { set, params } = buildPatch(patch, COLUMNS, 3);
      if (!set) return before;
      const rows = await uow.db.query<LegalEntityRow>(
        `UPDATE tenancy.legal_entities SET ${set}, version = version + 1, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND version = ${expectedVersion} RETURNING *`,
        [uow.tenantId, id, ...params],
      );
      if (rows.length === 0) throw new VersionConflictError(expectedVersion, before.version);
      const after = toLegalEntityDto(rows[0]!);
      uow.audit({
        action: 'tenancy.legal_entity.updated',
        resourceKind: 'legal_entity',
        resourceId: id,
        before,
        after,
      });
      return after;
    });
  }

  private async require(db: TenantScopedDb, id: string): Promise<LegalEntityOut> {
    const row = await db.maybeOne<LegalEntityRow>(
      'SELECT * FROM tenancy.legal_entities WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, id],
    );
    if (!row) throw new NotFoundError();
    return toLegalEntityDto(row);
  }
}
