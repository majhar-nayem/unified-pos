import { Injectable } from '@nestjs/common';
import type { PermissionKey } from '@pos/auth';
import type {
  ApiClientCreated,
  ApiClientDto,
  ClientCredentialsRequest,
  CreateApiClient,
  TokenPair,
} from '@pos/contracts';
import { newId } from '@pos/db';

import {
  AuthorizationService,
  NotFoundError,
  TenantDirectory,
  UnauthorizedError,
  UnitOfWork,
} from '../../kernel/public/index.js';
import { PasswordHasher } from '../crypto/password-hasher.js';
import { newClientSecret, newOpaqueToken } from '../crypto/random.js';
import { TokenService } from '../crypto/tokens.js';
import { LoginEventsRepository } from './login-events.repository.js';

interface ApiClientRow {
  id: string;
  tenant_id: string;
  name: string;
  client_id: string;
  secret_hash: string;
  scopes: string[];
  location_scope: string[] | null;
  rate_limit_per_minute: number;
  status: 'active' | 'revoked';
  created_at: Date;
  last_used_at: Date | null;
}

function toDto(r: ApiClientRow): ApiClientDto {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    clientId: r.client_id,
    scopes: r.scopes,
    locationScope: r.location_scope,
    rateLimitPerMinute: r.rate_limit_per_minute,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
  };
}

/** OAuth-style client credentials → `api` token carrying the client's scopes (no refresh; re-grant). */
@Injectable()
export class ClientAuthService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly tenants: TenantDirectory,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenService,
    private readonly events: LoginEventsRepository,
  ) {}

  async token(input: ClientCredentialsRequest): Promise<TokenPair> {
    const tenant = await this.tenants.findBySlug(input.tenantSlug);
    if (!tenant || tenant.status !== 'active') {
      await this.hasher.dummyVerify();
      throw new UnauthorizedError('BAD_CREDENTIALS', 'Invalid client credentials');
    }
    const client = await this.uow.readAs(tenant.id, (db) =>
      db.maybeOne<ApiClientRow>(
        'SELECT * FROM identity.api_clients WHERE tenant_id = $1 AND client_id = $2',
        [tenant.id, input.clientId],
      ),
    );
    const ok =
      client?.status === 'active' &&
      (await this.hasher.verify(client.secret_hash, input.clientSecret));
    await this.uow.runAs(tenant.id, { kind: 'api_client', id: client?.id ?? null }, async (uow) => {
      await this.events.record(uow.db, {
        outcome: ok ? 'success' : client?.status === 'revoked' ? 'revoked' : 'bad_credentials',
        method: 'client_secret',
        emailTried: input.clientId,
      });
      if (ok && client)
        await uow.db.query(
          'UPDATE identity.api_clients SET last_used_at = now() WHERE tenant_id = $1 AND id = $2',
          [tenant.id, client.id],
        );
    });
    if (!ok || !client)
      throw new UnauthorizedError('BAD_CREDENTIALS', 'Invalid client credentials');
    const access = await this.tokens.sign({
      sub: client.id,
      tid: tenant.id,
      knd: 'api',
      amr: ['client_secret'],
      mfa: false,
      av: 0,
      scp: client.scopes,
    });
    return { accessToken: access.token, expiresIn: access.expiresIn };
  }

  async list(): Promise<ApiClientDto[]> {
    await this.authz.assert('access.api_client.manage');
    return this.uow.read(async (db) =>
      (
        await db.query<ApiClientRow>(
          'SELECT * FROM identity.api_clients WHERE tenant_id = $1 ORDER BY name',
          [db.tenantId],
        )
      ).map(toDto),
    );
  }

  async create(input: CreateApiClient): Promise<ApiClientCreated> {
    await this.authz.assert('access.api_client.manage');
    const secret = newClientSecret();
    return this.uow.run(async (uow) => {
      const id = newId();
      const clientId = `c_${newOpaqueToken(12)}`;
      const rows = await uow.db.query<ApiClientRow>(
        'INSERT INTO identity.api_clients (id, tenant_id, name, client_id, secret_hash, scopes, location_scope, rate_limit_per_minute) VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 600)) RETURNING *',
        [
          id,
          uow.tenantId,
          input.name,
          clientId,
          await this.hasher.hash(secret),
          input.scopes as PermissionKey[],
          input.locationScope ?? null,
          input.rateLimitPerMinute ?? null,
        ],
      );
      const client = toDto(rows[0]!);
      uow.audit({
        action: 'access.api_client.created',
        resourceKind: 'api_client',
        resourceId: id,
        after: { name: client.name, scopes: client.scopes, locationScope: client.locationScope },
      });
      return { client, clientSecret: secret };
    });
  }

  async revoke(id: string): Promise<ApiClientDto> {
    await this.authz.assert('access.api_client.manage');
    return this.uow.run(async (uow) => {
      const rows = await uow.db.query<ApiClientRow>(
        "UPDATE identity.api_clients SET status = 'revoked' WHERE tenant_id = $1 AND id = $2 RETURNING *",
        [uow.tenantId, id],
      );
      if (!rows[0]) throw new NotFoundError();
      uow.audit({
        action: 'access.api_client.revoked',
        resourceKind: 'api_client',
        resourceId: id,
      });
      return toDto(rows[0]);
    });
  }
}
