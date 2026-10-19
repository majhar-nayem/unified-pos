import { Injectable } from '@nestjs/common';
import type { ScopeKind } from '@pos/auth';
import {
  CONFIG_KEYS,
  type ConfigEntryDto,
  type ConfigResolved,
  type PutConfig,
} from '@pos/contracts';
import { newId, type TenantScopedDb } from '@pos/db';

import {
  AuthorizationService,
  NotFoundError,
  RequestContextService,
  UnitOfWork,
  ValidationError,
  isOperator,
} from '../kernel/public/index.js';
import { type ConfigCandidate, isKnownConfigKey, resolveNearest } from './config.resolver.js';
import { HierarchyService, scopePath } from './hierarchy.service.js';
import { type ConfigEntryRow, toConfigEntryDto } from './rows.js';

/**
 * Versioned, scoped configuration (tenancy.config_entries). Effective value = nearest scope on the
 * path; every change inserts a new version (previous rows stay for rollback and audit).
 */
@Injectable()
export class ConfigService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly hierarchy: HierarchyService,
    private readonly context: RequestContextService,
  ) {}

  async getEffective(key: string, scopeKind: ScopeKind, scopeId: string): Promise<ConfigResolved> {
    await this.authz.assert('config.view', { kind: scopeKind, id: scopeId });
    return this.uow.read((db) => effectiveConfig(db, key, scopeKind, scopeId));
  }

  /** For other modules inside their own transaction (PIN policy, rounding). No permission check. */
  async effectiveIn(
    db: TenantScopedDb,
    key: string,
    scopeKind: ScopeKind,
    scopeId: string,
  ): Promise<ConfigResolved> {
    return effectiveConfig(db, key, scopeKind, scopeId);
  }

  async history(key: string, scopeKind: ScopeKind, scopeId: string): Promise<ConfigEntryDto[]> {
    await this.authz.assert('config.view', { kind: scopeKind, id: scopeId });
    return this.uow.read(async (db) =>
      (
        await db.query<ConfigEntryRow>(
          'SELECT * FROM tenancy.config_entries WHERE tenant_id = $1 AND scope_kind = $2 AND scope_id = $3 AND key = $4 ORDER BY version DESC',
          [db.tenantId, scopeKind, scopeId, key],
        )
      ).map(toConfigEntryDto),
    );
  }

  async put(input: PutConfig): Promise<ConfigEntryDto> {
    if (!isKnownConfigKey(input.key))
      throw new ValidationError({ key: `unknown configuration key ${input.key}` });
    const definition = CONFIG_KEYS[input.key];
    if (!(definition.scopes as readonly ScopeKind[]).includes(input.scopeKind)) {
      throw new ValidationError({
        scopeKind: `${input.key} cannot be set at ${input.scopeKind} scope`,
      });
    }
    const parsed = definition.schema.safeParse(input.value);
    if (!parsed.success)
      throw new ValidationError({ value: parsed.error.issues.map((i) => i.message) });

    await this.authz.assert('config.edit', { kind: input.scopeKind, id: input.scopeId });
    const principal = this.context.require().principal;
    const createdBy =
      principal && !isOperator(principal) && principal.kind === 'user' ? principal.subjectId : null;

    return this.uow.run(async (uow) => {
      await this.hierarchy.requireScope(uow.db, input.scopeKind, input.scopeId);
      const previous = await uow.db.maybeOne<ConfigEntryRow>(
        `UPDATE tenancy.config_entries SET is_current = false
         WHERE tenant_id = $1 AND scope_kind = $2 AND scope_id = $3 AND key = $4 AND is_current RETURNING *`,
        [uow.tenantId, input.scopeKind, input.scopeId, input.key],
      );
      const id = newId();
      const rows = await uow.db.query<ConfigEntryRow>(
        `INSERT INTO tenancy.config_entries (id, tenant_id, scope_kind, scope_id, key, value, version, created_by, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [
          id,
          uow.tenantId,
          input.scopeKind,
          input.scopeId,
          input.key,
          JSON.stringify(parsed.data),
          (previous?.version ?? 0) + 1,
          createdBy,
          input.reason ?? null,
        ],
      );
      const entry = toConfigEntryDto(rows[0]!);
      uow.audit({
        action: 'tenancy.config.changed',
        resourceKind: 'config_entry',
        resourceId: id,
        before: previous
          ? { key: previous.key, value: previous.value, version: previous.version }
          : null,
        after: {
          key: entry.key,
          value: entry.value,
          version: entry.version,
          scopeKind: entry.scopeKind,
          scopeId: entry.scopeId,
        },
        reason: input.reason ?? null,
        locationId: input.scopeKind === 'location' ? input.scopeId : null,
      });
      uow.emit({
        type: 'config.changed',
        aggregateKind: 'config_entry',
        aggregateId: id,
        aggregateVersion: entry.version,
        locationId: input.scopeKind === 'location' ? input.scopeId : null,
        payload: {
          key: entry.key,
          scopeKind: entry.scopeKind,
          scopeId: entry.scopeId,
          version: entry.version,
        },
      });
      return entry;
    });
  }
}

export async function effectiveConfig(
  db: TenantScopedDb,
  key: string,
  scopeKind: ScopeKind,
  scopeId: string,
): Promise<ConfigResolved> {
  const resolved = await scopePath(db, scopeKind, scopeId);
  if (!resolved) throw new NotFoundError();
  const rows = await db.query<{
    scope_kind: ScopeKind;
    scope_id: string;
    value: unknown;
    version: number;
  }>(
    `SELECT c.scope_kind, c.scope_id, c.value, c.version
     FROM tenancy.config_entries c
     WHERE c.tenant_id = $1 AND c.key = $2 AND c.is_current
       AND (c.scope_kind, c.scope_id) IN (SELECT kind, id FROM tenancy.fn_scope_path($3, $4))`,
    [db.tenantId, key, scopeKind, scopeId],
  );
  const candidates: ConfigCandidate[] = rows.map((r) => ({
    scopeKind: r.scope_kind,
    scopeId: r.scope_id,
    value: r.value,
    version: r.version,
  }));
  return resolveNearest(key, resolved.path, candidates);
}
