import { Injectable } from '@nestjs/common';
import type { CredentialDto } from '@pos/contracts';
import { newId, type TenantScopedDb } from '@pos/db';

export type CredentialKind = 'password' | 'passkey' | 'totp' | 'pos_pin';

export interface CredentialRow {
  id: string;
  tenant_id: string;
  user_id: string;
  kind: CredentialKind;
  location_id: string | null;
  secret_hash: string | null;
  public_key: Buffer | null;
  credential_id: Buffer | null;
  label: string | null;
  status: 'active' | 'revoked';
  created_at: Date;
  last_used_at: Date | null;
  sign_count: bigint;
  transports: string[] | null;
  aaguid: string | null;
  backed_up: boolean | null;
}

export function toCredentialDto(r: CredentialRow): CredentialDto {
  return {
    id: r.id,
    userId: r.user_id,
    kind: r.kind,
    locationId: r.location_id,
    label: r.label,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
  };
}

/** SQL for identity.user_credentials; every statement carries tenant_id. */
@Injectable()
export class CredentialsRepository {
  listForUser(db: TenantScopedDb, userId: string): Promise<CredentialRow[]> {
    return db.query<CredentialRow>(
      'SELECT * FROM identity.user_credentials WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at',
      [db.tenantId, userId],
    );
  }

  active(
    db: TenantScopedDb,
    userId: string,
    kind: CredentialKind,
    locationId?: string,
  ): Promise<CredentialRow[]> {
    return db.query<CredentialRow>(
      `SELECT * FROM identity.user_credentials
       WHERE tenant_id = $1 AND user_id = $2 AND kind = $3 AND status = 'active' AND ($4::uuid IS NULL OR location_id = $4)
       ORDER BY created_at`,
      [db.tenantId, userId, kind, locationId ?? null],
    );
  }

  activeKinds(db: TenantScopedDb, userId: string): Promise<CredentialKind[]> {
    return db
      .query<{ kind: CredentialKind }>(
        "SELECT DISTINCT kind FROM identity.user_credentials WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'",
        [db.tenantId, userId],
      )
      .then((rows) => rows.map((r) => r.kind));
  }

  async insert(
    db: TenantScopedDb,
    input: {
      userId: string;
      kind: CredentialKind;
      secretHash?: string | null;
      locationId?: string | null;
      publicKey?: Buffer | null;
      credentialId?: Buffer | null;
      label?: string | null;
      signCount?: bigint;
      transports?: string[] | null;
      aaguid?: string | null;
      backedUp?: boolean | null;
    },
  ): Promise<CredentialRow> {
    const id = newId();
    const rows = await db.query<CredentialRow>(
      `INSERT INTO identity.user_credentials (id, tenant_id, user_id, kind, location_id, secret_hash, public_key, credential_id, label, sign_count, transports, aaguid, backed_up)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [
        id,
        db.tenantId,
        input.userId,
        input.kind,
        input.locationId ?? null,
        input.secretHash ?? null,
        input.publicKey ?? null,
        input.credentialId ?? null,
        input.label ?? null,
        input.signCount ?? 0n,
        input.transports ?? null,
        input.aaguid ?? null,
        input.backedUp ?? null,
      ],
    );
    return rows[0]!;
  }

  async revoke(db: TenantScopedDb, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await db.query(
      "UPDATE identity.user_credentials SET status = 'revoked' WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND status = 'active'",
      [db.tenantId, ids],
    );
  }

  async revokeKind(
    db: TenantScopedDb,
    userId: string,
    kind: CredentialKind,
    locationId?: string,
  ): Promise<string[]> {
    const rows = await db.query<{ id: string }>(
      `UPDATE identity.user_credentials SET status = 'revoked'
       WHERE tenant_id = $1 AND user_id = $2 AND kind = $3 AND status = 'active' AND ($4::uuid IS NULL OR location_id = $4) RETURNING id`,
      [db.tenantId, userId, kind, locationId ?? null],
    );
    return rows.map((r) => r.id);
  }

  async touch(db: TenantScopedDb, id: string, signCount?: bigint): Promise<void> {
    await db.query(
      'UPDATE identity.user_credentials SET last_used_at = now(), sign_count = COALESCE($3, sign_count) WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, id, signCount ?? null],
    );
  }

  byCredentialId(db: TenantScopedDb, credentialId: Buffer): Promise<CredentialRow | null> {
    return db.maybeOne<CredentialRow>(
      "SELECT * FROM identity.user_credentials WHERE tenant_id = $1 AND kind = 'passkey' AND credential_id = $2 AND status = 'active'",
      [db.tenantId, credentialId],
    );
  }
}
