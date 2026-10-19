import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateTerminal,
  PAYMENT_PERMISSIONS,
  type PaymentTerminalDto,
  type UpdateTerminal,
} from '@pos/contracts';
import { newId, type TenantScopedDb } from '@pos/db';

import {
  AuthorizationService,
  ConflictError,
  NotFoundError,
  RequestContextService,
  UnitOfWork,
  isOperator,
  principalReaches,
} from '../kernel/public/index.js';
import { PROVIDER_REGISTRY, ProviderRegistry } from './providers/provider-registry.js';
import type { ProviderAccountRow, TerminalRow } from './rows.js';
import { toTerminalDto } from './rows.js';

type TerminalWithAccount = TerminalRow & {
  account_provider: string;
  account_capabilities: ProviderAccountRow['capabilities'];
  account_settings: ProviderAccountRow['settings'];
  ancestor_ids?: string[];
};

const SELECT = `
  SELECT t.*, a.provider AS account_provider, a.capabilities AS account_capabilities, a.settings AS account_settings
    FROM payments.payment_terminals t
    JOIN payments.payment_provider_accounts a ON a.tenant_id = t.tenant_id AND a.id = t.provider_account_id`;

/** Whether this terminal's connection mode permits offline card approval under its account's capabilities and settings. */
export function terminalOfflineCapable(row: TerminalWithAccount): boolean {
  const mode = row.account_capabilities?.offlineModes?.[row.connection_mode];
  return mode !== undefined && mode !== 'none' && row.account_settings?.offline?.enabled !== false;
}

@Injectable()
export class TerminalsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly context: RequestContextService,
    @Inject(PROVIDER_REGISTRY) private readonly registry: ProviderRegistry,
  ) {}

  async create(input: CreateTerminal): Promise<PaymentTerminalDto> {
    await this.authz.assert(PAYMENT_PERMISSIONS.terminalManage, {
      kind: 'location',
      id: input.locationId,
    });
    return this.uow.run(async (uow) => {
      const account = await uow.db.maybeOne<{ id: string }>(
        'SELECT id FROM payments.payment_provider_accounts WHERE tenant_id = $1 AND id = $2',
        [uow.tenantId, input.providerAccountId],
      );
      if (!account) throw new NotFoundError();
      const id = newId();
      await uow.db.query(
        `INSERT INTO payments.payment_terminals
           (id, tenant_id, location_id, provider_account_id, serial_number, model, connection_mode, address, assigned_register_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          uow.tenantId,
          input.locationId,
          input.providerAccountId,
          input.serialNumber,
          input.model ?? null,
          input.connectionMode,
          input.address ?? null,
          input.assignedRegisterId ?? null,
        ],
      );
      const dto = await this.fetch(uow.db, id);
      uow.audit({
        action: 'payments.terminal.created',
        resourceKind: 'payment_terminal',
        resourceId: id,
        locationId: input.locationId,
        after: { serialNumber: input.serialNumber, connectionMode: input.connectionMode },
      });
      return dto;
    });
  }

  async list(): Promise<PaymentTerminalDto[]> {
    this.authz.assertAnywhere(PAYMENT_PERMISSIONS.view);
    const principal = this.context.require().principal!;
    const rows = await this.uow.read((db) =>
      db.query<TerminalWithAccount>(
        `SELECT t.*, a.provider AS account_provider, a.capabilities AS account_capabilities, a.settings AS account_settings,
                COALESCE(array_agg(p.ancestor_id ORDER BY p.depth) FILTER (WHERE p.ancestor_id IS NOT NULL), '{}') AS ancestor_ids
           FROM payments.payment_terminals t
           JOIN payments.payment_provider_accounts a ON a.tenant_id = t.tenant_id AND a.id = t.provider_account_id
           JOIN tenancy.locations l ON l.tenant_id = t.tenant_id AND l.id = t.location_id
           LEFT JOIN tenancy.org_unit_paths p ON p.tenant_id = l.tenant_id AND p.descendant_id = l.org_unit_id
          WHERE t.tenant_id = $1
          GROUP BY t.id, a.provider, a.capabilities, a.settings
          ORDER BY t.serial_number, t.id`,
        [db.tenantId],
      ),
    );
    return rows
      .filter(
        (r) =>
          isOperator(principal) ||
          principalReaches(principal, {
            kind: 'location',
            id: r.location_id,
            path: [
              { kind: 'location', id: r.location_id },
              ...(r.ancestor_ids ?? []).map((id) => ({ kind: 'org_unit' as const, id })),
            ],
          }),
      )
      .map((r) => toTerminalDto(r, terminalOfflineCapable(r)));
  }

  async get(id: string): Promise<PaymentTerminalDto> {
    const row = await this.uow.read((db) => this.load(db, id));
    if (!row) throw new NotFoundError();
    await this.authz.assert(PAYMENT_PERMISSIONS.view, { kind: 'location', id: row.location_id });
    return toTerminalDto(row, terminalOfflineCapable(row));
  }

  async update(id: string, patch: UpdateTerminal): Promise<PaymentTerminalDto> {
    return this.uow.run(async (uow) => {
      const before = await this.load(uow.db, id);
      if (!before) throw new NotFoundError();
      await this.authz.assert(PAYMENT_PERMISSIONS.terminalManage, {
        kind: 'location',
        id: before.location_id,
      });
      const sets: string[] = [];
      const params: unknown[] = [uow.tenantId, id];
      const set = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      if (patch.address !== undefined) set('address', patch.address);
      if (patch.assignedRegisterId !== undefined)
        set('assigned_register_id', patch.assignedRegisterId);
      if (patch.status !== undefined) set('status', patch.status);
      if (sets.length > 0)
        await uow.db.query(
          `UPDATE payments.payment_terminals SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = $2`,
          params,
        );
      const after = await this.fetch(uow.db, id);
      uow.audit({
        action: 'payments.terminal.updated',
        resourceKind: 'payment_terminal',
        resourceId: id,
        locationId: before.location_id,
        before: { status: before.status, address: before.address },
        after: { status: after.status, address: after.address },
      });
      return after;
    });
  }

  /** Pair with the provider using the on-screen code; the code is used once and never stored. */
  async pair(id: string, code: string): Promise<PaymentTerminalDto> {
    const row = await this.uow.read((db) => this.load(db, id));
    if (!row) throw new NotFoundError();
    await this.authz.assert(PAYMENT_PERMISSIONS.terminalManage, {
      kind: 'location',
      id: row.location_id,
    });
    const adapter = this.registry.terminal(row.account_provider);
    if (!adapter)
      throw new ConflictError(
        'TERMINAL_ADAPTER_UNAVAILABLE',
        `No terminal adapter is installed for provider "${row.account_provider}"`,
      );
    const result = await adapter.pair(
      {
        id: row.id,
        provider: row.account_provider as never,
        serialNumber: row.serial_number,
        connectionMode: row.connection_mode,
        address: row.address,
        pairingRef: row.pairing_ref,
      },
      code,
    );
    if (result.outcome === 'rejected')
      throw new ConflictError(
        'PAIRING_REJECTED',
        `Terminal pairing was rejected: ${result.reason}`,
      );
    return this.uow.run(async (uow) => {
      await uow.db.query(
        `UPDATE payments.payment_terminals
            SET status = 'paired', pairing_ref = $3, model = COALESCE($4, model), firmware = COALESCE($5, firmware), last_seen_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [uow.tenantId, id, result.pairingRef, result.model ?? null, result.firmware ?? null],
      );
      uow.audit({
        action: 'payments.terminal.paired',
        resourceKind: 'payment_terminal',
        resourceId: id,
        locationId: row.location_id,
      });
      return this.fetch(uow.db, id);
    });
  }

  async load(db: TenantScopedDb, id: string): Promise<TerminalWithAccount | null> {
    return db.maybeOne<TerminalWithAccount>(`${SELECT} WHERE t.tenant_id = $1 AND t.id = $2`, [
      db.tenantId,
      id,
    ]);
  }

  private async fetch(db: TenantScopedDb, id: string): Promise<PaymentTerminalDto> {
    const row = await this.load(db, id);
    if (!row) throw new NotFoundError();
    return toTerminalDto(row, terminalOfflineCapable(row));
  }
}
