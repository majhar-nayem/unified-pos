import { Injectable } from '@nestjs/common';
import type { TenantScopedDb } from '@pos/db';

export type LoginOutcome =
  'success' | 'bad_credentials' | 'locked' | 'mfa_required' | 'mfa_failed' | 'revoked';
export type LoginMethod =
  'password' | 'totp' | 'passkey' | 'pin' | 'device_key' | 'client_secret' | 'refresh';

export interface LoginEventInput {
  readonly userId?: string | null;
  readonly emailTried?: string | null;
  readonly outcome: LoginOutcome;
  readonly method: LoginMethod;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly deviceId?: string | null;
}

/** Every authentication attempt is recorded (docs/01 §11 monitoring: brute force, impossible travel). */
@Injectable()
export class LoginEventsRepository {
  async record(db: TenantScopedDb, event: LoginEventInput): Promise<void> {
    await db.query(
      'INSERT INTO identity.login_events (tenant_id, user_id, email_tried, outcome, method, ip, user_agent, device_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [
        db.tenantId,
        event.userId ?? null,
        event.emailTried ?? null,
        event.outcome,
        event.method,
        event.ip ?? null,
        event.userAgent ?? null,
        event.deviceId ?? null,
      ],
    );
  }
}
