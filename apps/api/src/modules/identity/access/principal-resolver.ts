import { Injectable } from '@nestjs/common';
import type { AccessTokenClaims, Assignment, PermissionKey, Principal } from '@pos/auth';

import {
  KernelPorts,
  type TenantPrincipal,
  UnauthorizedError,
  UnitOfWork,
} from '../../kernel/public/index.js';
import { DevicesService } from '../../devices/public/index.js';
import { EffectivePermissionsService } from './effective-permissions.service.js';

export interface ResolvedPrincipal {
  readonly principal: TenantPrincipal;
  readonly mfaRequired: boolean;
}

/** Turns verified token claims into the Principal the kernel guards and services work with. */
@Injectable()
export class PrincipalResolver {
  constructor(
    private readonly effective: EffectivePermissionsService,
    private readonly devices: DevicesService,
    private readonly uow: UnitOfWork,
    private readonly ports: KernelPorts,
  ) {}

  async resolve(claims: AccessTokenClaims): Promise<ResolvedPrincipal> {
    switch (claims.knd) {
      case 'web':
      case 'pos':
      case 'preauth':
        return this.user(claims);
      case 'device':
        return this.device(claims);
      case 'api':
        return this.apiClient(claims);
    }
  }

  private async user(claims: AccessTokenClaims): Promise<ResolvedPrincipal> {
    const effective = await this.effective.build(claims.tid, claims.sub);
    const principal: TenantPrincipal = {
      tenantId: claims.tid,
      subjectId: claims.sub,
      kind: 'user',
      ...(claims.sid ? { sessionId: claims.sid } : {}),
      ...(claims.did ? { deviceId: claims.did } : {}),
      ...(claims.loc ? { locationId: claims.loc } : {}),
      mfaVerified: claims.mfa === true,
      assignmentsVersion: effective.version,
      assignments: effective.assignments,
      tokenKind: claims.knd,
    };
    return { principal, mfaRequired: effective.mfaRequired };
  }

  private async device(claims: AccessTokenClaims): Promise<ResolvedPrincipal> {
    const device = await this.devices.findEnrolled(claims.tid, claims.sub);
    if (!device) throw new UnauthorizedError('DEVICE_REVOKED', 'Device is not enrolled');
    const scope = device.register_id
      ? { kind: 'register' as const, id: device.register_id }
      : { kind: 'location' as const, id: device.location_id };
    const expanded = await this.ports.scopeResolver.expand(claims.tid, scope);
    const assignment: Assignment = {
      assignmentId: `device:${device.id}`,
      role: 'device',
      permissions: ['devices.self', 'sync.upload', 'sync.download'] as PermissionKey[],
      scope,
      coveredScopeIds: expanded ? [...expanded.locationIds, ...expanded.registerIds] : [],
    };
    return {
      principal: {
        tenantId: claims.tid,
        subjectId: device.id,
        kind: 'device',
        deviceId: device.id,
        locationId: device.location_id,
        mfaVerified: false,
        assignmentsVersion: 0,
        assignments: [assignment],
        tokenKind: 'device',
      },
      mfaRequired: false,
    };
  }

  private async apiClient(claims: AccessTokenClaims): Promise<ResolvedPrincipal> {
    const client = await this.uow.readAs(claims.tid, (db) =>
      db.maybeOne<{
        id: string;
        scopes: string[];
        location_scope: string[] | null;
        status: string;
      }>(
        'SELECT id, scopes, location_scope, status FROM identity.api_clients WHERE tenant_id = $1 AND id = $2',
        [claims.tid, claims.sub],
      ),
    );
    if (!client || client.status !== 'active')
      throw new UnauthorizedError('CLIENT_REVOKED', 'API client is not active');
    const permissions = (claims.scp ?? client.scopes) as PermissionKey[];
    const assignments: Assignment[] = client.location_scope?.length
      ? await Promise.all(
          client.location_scope.map(async (locationId, i) => {
            const expanded = await this.ports.scopeResolver.expand(claims.tid, {
              kind: 'location',
              id: locationId,
            });
            return {
              assignmentId: `api:${client.id}:${i}`,
              role: 'api_client',
              permissions,
              scope: { kind: 'location' as const, id: locationId },
              coveredScopeIds: expanded ? [...expanded.registerIds] : [],
            };
          }),
        )
      : [
          {
            assignmentId: `api:${client.id}`,
            role: 'api_client',
            permissions,
            scope: { kind: 'tenant', id: claims.tid },
            coveredScopeIds: [],
          },
        ];
    const principal: Principal & { tokenKind: 'api' } = {
      tenantId: claims.tid,
      subjectId: client.id,
      kind: 'api_client',
      mfaVerified: false,
      assignmentsVersion: 0,
      assignments,
      tokenKind: 'api',
    };
    return { principal, mfaRequired: false };
  }
}
