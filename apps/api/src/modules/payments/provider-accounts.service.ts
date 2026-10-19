import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateProviderAccount,
  PAYMENT_PERMISSIONS,
  type ProviderAccountDto,
  type UpdateProviderAccount,
} from '@pos/contracts';
import { newId, type TenantScopedDb } from '@pos/db';
import type { Scope } from '@pos/auth';

import {
  AuthorizationService,
  NotFoundError,
  RequestContextService,
  UnitOfWork,
  ValidationError,
} from '../kernel/public/index.js';
import { PROVIDER_REGISTRY, ProviderRegistry } from './providers/provider-registry.js';
import { type ProviderAccountRow, toProviderAccountDto } from './rows.js';

@Injectable()
export class ProviderAccountsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly context: RequestContextService,
    @Inject(PROVIDER_REGISTRY) private readonly registry: ProviderRegistry,
  ) {}

  async create(input: CreateProviderAccount): Promise<ProviderAccountDto> {
    const tenantId = this.context.require().tenantId!;
    const scope = this.scopeOf(tenantId, input.scopeKind, input.scopeId ?? null);
    await this.authz.assert(PAYMENT_PERMISSIONS.providerManage, scope);
    if (input.scopeKind !== 'tenant' && !input.scopeId)
      throw new ValidationError({ scopeId: 'required unless scopeKind is tenant' });
    const adapter = this.registry.find(input.provider);
    const capabilities = adapter
      ? adapter.capabilities({
          id: 'pending',
          provider: adapter.key,
          currency: input.currencies[0] ?? 'AUD',
          credentialsRef: input.credentialsRef,
        })
      : {};
    return this.uow.run(async (uow) => {
      const rows = await uow.db.query<ProviderAccountRow>(
        `INSERT INTO payments.payment_provider_accounts
           (id, tenant_id, provider, name, scope_kind, scope_id, merchant_ref, credentials_ref, settings, capabilities, currencies, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::char(3)[], $12) RETURNING *`,
        [
          newId(),
          uow.tenantId,
          input.provider,
          input.name,
          input.scopeKind,
          input.scopeKind === 'tenant' ? null : (input.scopeId ?? null),
          input.merchantRef ?? null,
          input.credentialsRef,
          JSON.stringify(input.settings ?? {}),
          JSON.stringify(capabilities),
          input.currencies,
          input.status,
        ],
      );
      const dto = this.toDto(rows[0]!);
      uow.audit({
        action: 'payments.provider_account.created',
        resourceKind: 'payment_provider_account',
        resourceId: dto.id,
        after: {
          provider: dto.provider,
          name: dto.name,
          scopeKind: dto.scopeKind,
          status: dto.status,
        },
      });
      return dto;
    });
  }

  async update(id: string, patch: UpdateProviderAccount): Promise<ProviderAccountDto> {
    return this.uow.run(async (uow) => {
      const before = await this.require(uow.db, id, true);
      await this.authz.assert(
        PAYMENT_PERMISSIONS.providerManage,
        this.scopeOf(uow.tenantId, before.scope_kind, before.scope_id),
      );
      const sets: string[] = [];
      const params: unknown[] = [uow.tenantId, id];
      const set = (column: string, value: unknown, cast = '') => {
        params.push(value);
        sets.push(`${column} = $${params.length}${cast}`);
      };
      if (patch.name !== undefined) set('name', patch.name);
      if (patch.merchantRef !== undefined) set('merchant_ref', patch.merchantRef);
      if (patch.credentialsRef !== undefined) set('credentials_ref', patch.credentialsRef);
      if (patch.settings !== undefined) set('settings', JSON.stringify(patch.settings));
      if (patch.currencies !== undefined) set('currencies', patch.currencies, '::char(3)[]');
      if (patch.status !== undefined) set('status', patch.status);
      if (sets.length === 0) return this.toDto(before);
      const rows = await uow.db.query<ProviderAccountRow>(
        `UPDATE payments.payment_provider_accounts SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        params,
      );
      const after = this.toDto(rows[0]!);
      uow.audit({
        action: 'payments.provider_account.updated',
        resourceKind: 'payment_provider_account',
        resourceId: id,
        before: this.toDto(before),
        after,
      });
      return after;
    });
  }

  async list(): Promise<ProviderAccountDto[]> {
    this.authz.assertAnywhere(PAYMENT_PERMISSIONS.view);
    const rows = await this.uow.read((db) =>
      db.query<ProviderAccountRow>(
        'SELECT * FROM payments.payment_provider_accounts WHERE tenant_id = $1 ORDER BY created_at, id',
        [db.tenantId],
      ),
    );
    const tenantId = this.context.require().tenantId!;
    const visible: ProviderAccountDto[] = [];
    for (const row of rows) {
      if (row.scope_kind === 'tenant') {
        visible.push(this.toDto(row));
        continue;
      }
      const decision = await this.authz.can(
        PAYMENT_PERMISSIONS.view,
        this.scopeOf(tenantId, row.scope_kind, row.scope_id),
      );
      if (decision.allowed) visible.push(this.toDto(row));
    }
    return visible;
  }

  async get(id: string): Promise<ProviderAccountDto> {
    const row = await this.uow.read((db) => this.require(db, id));
    if (row.scope_kind !== 'tenant') {
      await this.authz.assert(
        PAYMENT_PERMISSIONS.view,
        this.scopeOf(row.tenant_id, row.scope_kind, row.scope_id),
      );
    } else {
      this.authz.assertAnywhere(PAYMENT_PERMISSIONS.view);
    }
    return this.toDto(row);
  }

  /** Loaded inside the payment flows: no permission check (the caller already holds one on the intent's location). */
  async load(db: TenantScopedDb, id: string): Promise<ProviderAccountRow | null> {
    return db.maybeOne<ProviderAccountRow>(
      'SELECT * FROM payments.payment_provider_accounts WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, id],
    );
  }

  toDto(row: ProviderAccountRow): ProviderAccountDto {
    return toProviderAccountDto(row, this.registry.find(row.provider)?.simulated ?? false);
  }

  private scopeOf(
    tenantId: string,
    kind: ProviderAccountRow['scope_kind'],
    id: string | null,
  ): Scope {
    return kind === 'tenant' || !id ? { kind: 'tenant', id: tenantId } : { kind, id };
  }

  private async require(db: TenantScopedDb, id: string, lock = false): Promise<ProviderAccountRow> {
    const row = await db.maybeOne<ProviderAccountRow>(
      `SELECT * FROM payments.payment_provider_accounts WHERE tenant_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`,
      [db.tenantId, id],
    );
    if (!row) throw new NotFoundError();
    return row;
  }
}
