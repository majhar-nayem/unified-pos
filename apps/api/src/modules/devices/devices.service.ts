import { randomInt } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { CreateEnrollmentCode, DeviceDto } from '@pos/contracts';
import { newId, type TenantScopedDb, type TenantUnitOfWork } from '@pos/db';
import type { Redis } from 'ioredis';

import {
  AuthorizationService,
  ConflictError,
  KernelPorts,
  NotFoundError,
  REDIS,
  RequestContextService,
  TenantDirectory,
  UnitOfWork,
  isOperator,
  principalReaches,
} from '../kernel/public/index.js';

export interface DeviceRow {
  id: string;
  tenant_id: string;
  location_id: string;
  register_id: string | null;
  kind: DeviceDto['kind'];
  name: string;
  platform: DeviceDto['platform'];
  app_version: string | null;
  enrollment_status: DeviceDto['enrollmentStatus'];
  public_key: Buffer | null;
  enrolled_at: Date | null;
  revoked_at: Date | null;
  last_seen_at: Date | null;
}

export function toDeviceDto(r: DeviceRow): DeviceDto {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    locationId: r.location_id,
    registerId: r.register_id,
    kind: r.kind,
    name: r.name,
    platform: r.platform,
    appVersion: r.app_version,
    enrollmentStatus: r.enrollment_status,
    enrolledAt: r.enrolled_at ? r.enrolled_at.toISOString() : null,
    revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
    lastSeenAt: r.last_seen_at ? r.last_seen_at.toISOString() : null,
  };
}

export interface EnrollmentCodeRow {
  code: string;
  tenant_id: string;
  location_id: string;
  register_id: string | null;
  kind: DeviceDto['kind'];
  expires_at: Date;
  used_at: Date | null;
}

const CODE_TTL_MINUTES = 15;
const STATUS_CACHE_SECONDS = 60;

/** devices.devices + device_enrollment_codes (docs/01 §11: device-bound sessions, revocation). */
@Injectable()
export class DevicesService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly context: RequestContextService,
    private readonly ports: KernelPorts,
    private readonly tenants: TenantDirectory,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Codes are `<tenant-slug>.<12 Crockford chars>` and stored in full: the PK is global, the slug lets the device find its tenant. */
  async issueEnrollmentCode(
    input: CreateEnrollmentCode,
  ): Promise<{ code: string; expiresAt: string }> {
    await this.authz.assert('devices.enroll', { kind: 'location', id: input.locationId });
    const tenantId = this.context.require().tenantId!;
    const tenant = await this.tenants.findById(tenantId);
    if (!tenant) throw new NotFoundError();
    const code = `${tenant.slug}.${newEnrollmentCode()}`;
    const principal = this.context.require().principal!;
    const createdBy =
      !isOperator(principal) && principal.kind === 'user' ? principal.subjectId : null;
    return this.uow.run(async (uow) => {
      const rows = await uow.db.query<{ expires_at: Date }>(
        `INSERT INTO devices.device_enrollment_codes (code, tenant_id, location_id, register_id, kind, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' minutes')::interval) RETURNING expires_at`,
        [
          code,
          uow.tenantId,
          input.locationId,
          input.registerId ?? null,
          input.kind,
          createdBy ?? '00000000-0000-0000-0000-000000000000',
          String(CODE_TTL_MINUTES),
        ],
      );
      uow.audit({
        action: 'devices.enrollment_code.issued',
        resourceKind: 'enrollment_code',
        locationId: input.locationId,
        after: { kind: input.kind, registerId: input.registerId ?? null },
      });
      return { code, expiresAt: rows[0]!.expires_at.toISOString() };
    });
  }

  /** Consume a code and create the device inside the caller's transaction (no principal: enrolment is pre-auth). */
  async enroll(
    uow: TenantUnitOfWork,
    code: string,
    input: { publicKey: Buffer; name: string; platform: string; appVersion: string },
  ): Promise<DeviceDto> {
    const row = await uow.db.maybeOne<EnrollmentCodeRow>(
      'SELECT * FROM devices.device_enrollment_codes WHERE tenant_id = $1 AND code = $2 FOR UPDATE',
      [uow.tenantId, code],
    );
    if (!row || row.used_at || row.expires_at.getTime() < Date.now())
      throw new NotFoundError('Enrollment code is invalid, used or expired');
    const id = newId();
    const rows = await uow.db.query<DeviceRow>(
      `INSERT INTO devices.devices (id, tenant_id, location_id, register_id, kind, name, platform, app_version, enrollment_status, public_key, enrolled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'enrolled', $9, now()) RETURNING *`,
      [
        id,
        uow.tenantId,
        row.location_id,
        row.register_id,
        row.kind,
        input.name,
        input.platform,
        input.appVersion,
        input.publicKey,
      ],
    );
    await uow.db.query(
      'UPDATE devices.device_enrollment_codes SET used_at = now(), used_by_device_id = $3 WHERE tenant_id = $1 AND code = $2',
      [uow.tenantId, code, id],
    );
    const device = toDeviceDto(rows[0]!);
    uow.audit({
      action: 'devices.enrolled',
      resourceKind: 'device',
      resourceId: id,
      locationId: device.locationId,
      deviceId: id,
      after: { name: device.name, kind: device.kind, platform: device.platform },
    });
    uow.emit({
      type: 'device.enrolled',
      aggregateKind: 'device',
      aggregateId: id,
      locationId: device.locationId,
      payload: { kind: device.kind, name: device.name },
    });
    return device;
  }

  async list(): Promise<DeviceDto[]> {
    this.authz.assertAnywhere('devices.view');
    const principal = this.context.require().principal!;
    const rows = await this.uow.read((db) =>
      db.query<DeviceRow & { ancestor_ids: string[] }>(
        `SELECT d.*, COALESCE(array_agg(p.ancestor_id ORDER BY p.depth) FILTER (WHERE p.ancestor_id IS NOT NULL), '{}') AS ancestor_ids
         FROM devices.devices d
         JOIN tenancy.locations l ON l.tenant_id = d.tenant_id AND l.id = d.location_id
         LEFT JOIN tenancy.org_unit_paths p ON p.tenant_id = l.tenant_id AND p.descendant_id = l.org_unit_id
         WHERE d.tenant_id = $1 GROUP BY d.id ORDER BY d.name`,
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
              ...r.ancestor_ids.map((id) => ({ kind: 'org_unit' as const, id })),
            ],
          }),
      )
      .map(toDeviceDto);
  }

  async get(deviceId: string): Promise<DeviceDto> {
    const row = await this.uow.read((db) => this.require(db, deviceId));
    await this.authz.assert('devices.view', { kind: 'location', id: row.location_id });
    return toDeviceDto(row);
  }

  async revoke(deviceId: string, reason?: string): Promise<DeviceDto> {
    return this.uow.run(async (uow) => {
      const before = await this.require(uow.db, deviceId);
      await this.authz.assert('devices.revoke', { kind: 'location', id: before.location_id });
      if (before.enrollment_status === 'revoked')
        throw new ConflictError('DEVICE_ALREADY_REVOKED', 'Device is already revoked');
      const rows = await uow.db.query<DeviceRow>(
        "UPDATE devices.devices SET enrollment_status = 'revoked', revoked_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *",
        [uow.tenantId, deviceId],
      );
      await uow.db.query(
        "UPDATE identity.auth_sessions SET revoked_at = now(), revoke_reason = 'device_revoked' WHERE tenant_id = $1 AND device_id = $2 AND revoked_at IS NULL",
        [uow.tenantId, deviceId],
      );
      const after = toDeviceDto(rows[0]!);
      uow.audit({
        action: 'devices.revoked',
        resourceKind: 'device',
        resourceId: deviceId,
        deviceId,
        locationId: after.locationId,
        reason: reason ?? null,
        before: toDeviceDto(before),
        after,
      });
      uow.emit({
        type: 'device.revoked',
        aggregateKind: 'device',
        aggregateId: deviceId,
        locationId: after.locationId,
        payload: { reason: reason ?? null },
      });
      uow.onCommitted(() =>
        this.redis.del(`device:status:${uow.tenantId}:${deviceId}`).then(() => undefined),
      );
      return after;
    });
  }

  /** Enrolled device row for token resolution, with a short Redis cache for revocation checks. */
  async findEnrolled(tenantId: string, deviceId: string): Promise<DeviceRow | null> {
    const cacheKey = `device:status:${tenantId}:${deviceId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached === 'revoked') return null;
    const row = await this.uow.readAs(tenantId, (db) =>
      db.maybeOne<DeviceRow>('SELECT * FROM devices.devices WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        deviceId,
      ]),
    );
    if (!row || row.enrollment_status !== 'enrolled') {
      await this.redis.set(cacheKey, 'revoked', 'EX', STATUS_CACHE_SECONDS);
      return null;
    }
    return row;
  }

  async touchLastSeen(tenantId: string, deviceId: string): Promise<void> {
    await this.uow.runAs(tenantId, { kind: 'device', id: deviceId }, (uow) =>
      uow.db
        .query('UPDATE devices.devices SET last_seen_at = now() WHERE tenant_id = $1 AND id = $2', [
          tenantId,
          deviceId,
        ])
        .then(() => undefined),
    );
  }

  private async require(db: TenantScopedDb, deviceId: string): Promise<DeviceRow> {
    const row = await db.maybeOne<DeviceRow>(
      'SELECT * FROM devices.devices WHERE tenant_id = $1 AND id = $2',
      [db.tenantId, deviceId],
    );
    if (!row) throw new NotFoundError();
    return row;
  }

  /** The scope resolver is needed by the principal resolver for device principals. */
  get scopeResolver() {
    return this.ports.scopeResolver;
  }
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newEnrollmentCode(length = 12): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CROCKFORD[randomInt(CROCKFORD.length)];
  return out;
}
