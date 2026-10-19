import { Controller, Delete, Get, HttpCode, Patch, Post, Put } from '@nestjs/common';
import {
  ApiClientCreatedSchema,
  ApiClientSchema,
  ApprovalRequestSchema,
  ApprovalStatusSchema,
  CloneRoleSchema,
  CreateApiClientSchema,
  CreateApprovalSchema,
  CreateRoleAssignmentSchema,
  CreateRoleSchema,
  DecideApprovalSchema,
  RevokeRoleAssignmentSchema,
  RoleAssignmentSchema,
  RoleLimitsSchema,
  RoleSchema,
  UpdateRolePermissionsSchema,
} from '@pos/contracts';
import { z } from 'zod';

import { Contract, ValidBody, ValidParams, ValidQuery } from '../../kernel/public/index.js';
import { AssignmentsService } from '../access/assignments.service.js';
import { RolesService } from '../access/roles.service.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { ClientAuthService } from '../authn/client-auth.service.js';

const uuid = z.string().uuid();
const ACCESS = ['access'] as const;

@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @Contract({
    operationId: 'access.role.list',
    tags: ACCESS,
    response: z.array(RoleSchema),
    permission: 'access.role.view',
  })
  list() {
    return this.roles.list();
  }

  @Post()
  @Contract({
    operationId: 'access.role.create',
    tags: ACCESS,
    body: CreateRoleSchema,
    response: RoleSchema,
    permission: 'access.role.manage',
    scope: { kind: 'tenant' },
    idempotent: true,
    examples: {
      body: { key: 'floor_lead', name: 'Floor lead', permissions: ['orders.discount.apply'] },
    },
  })
  create(@ValidBody() body: z.infer<typeof CreateRoleSchema>) {
    return this.roles.create(body);
  }

  @Get(':roleId')
  @Contract({
    operationId: 'access.role.get',
    tags: ACCESS,
    params: z.object({ roleId: uuid }),
    response: RoleSchema,
    permission: 'access.role.view',
    scope: { kind: 'tenant' },
    examples: { params: { roleId: 'roleId' } },
  })
  get(@ValidParams() params: { roleId: string }) {
    return this.roles.get(params.roleId);
  }

  @Post(':roleId/clone')
  @Contract({
    operationId: 'access.role.clone',
    tags: ACCESS,
    params: z.object({ roleId: uuid }),
    body: CloneRoleSchema,
    response: RoleSchema,
    permission: 'access.role.manage',
    scope: { kind: 'tenant' },
    idempotent: true,
    examples: { params: { roleId: 'roleId' }, body: { key: 'cashier_plus', name: 'Cashier plus' } },
  })
  clone(
    @ValidParams() params: { roleId: string },
    @ValidBody() body: z.infer<typeof CloneRoleSchema>,
  ) {
    return this.roles.clone(params.roleId, body);
  }

  @Put(':roleId/permissions')
  @Contract({
    operationId: 'access.role.permissions',
    tags: ACCESS,
    params: z.object({ roleId: uuid }),
    body: UpdateRolePermissionsSchema,
    response: RoleSchema,
    permission: 'access.role.manage',
    scope: { kind: 'tenant' },
    examples: {
      params: { roleId: 'roleId' },
      body: { permissions: ['orders.discount.apply', 'approvals.request'] },
    },
  })
  permissions(
    @ValidParams() params: { roleId: string },
    @ValidBody() body: z.infer<typeof UpdateRolePermissionsSchema>,
  ) {
    return this.roles.updatePermissions(params.roleId, body.permissions);
  }

  @Put(':roleId/limits')
  @Contract({
    operationId: 'access.role.limits',
    tags: ACCESS,
    params: z.object({ roleId: uuid }),
    body: RoleLimitsSchema,
    response: RoleSchema,
    permission: 'access.limit.manage',
    scope: { kind: 'tenant' },
    examples: {
      params: { roleId: 'roleId' },
      body: { limits: { 'orders.discount.max_percent': 20 } },
    },
  })
  limits(
    @ValidParams() params: { roleId: string },
    @ValidBody() body: z.infer<typeof RoleLimitsSchema>,
  ) {
    return this.roles.setLimits(params.roleId, body.limits);
  }
}

@Controller('role-assignments')
export class RoleAssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Get()
  @Contract({
    operationId: 'access.assignment.list',
    tags: ACCESS,
    query: z.object({ userId: uuid }),
    response: z.array(RoleAssignmentSchema),
    permission: 'access.assignment.view',
    examples: { query: { userId: '$fixture:userId' } },
  })
  list(@ValidQuery() query: { userId: string }) {
    return this.assignments.listForUser(query.userId);
  }

  @Post()
  @Contract({
    operationId: 'access.assignment.grant',
    tags: ACCESS,
    body: CreateRoleAssignmentSchema,
    response: RoleAssignmentSchema,
    permission: 'access.assignment.grant',
    scope: { kind: 'dynamic', from: 'body', kindField: 'scope.kind', idField: 'scope.id' },
    idempotent: true,
    examples: {
      body: {
        userId: '$fixture:userId',
        roleId: '$fixture:roleId',
        scope: { kind: 'location', id: '$fixture:locationId' },
        reason: 'new hire',
      },
    },
  })
  grant(@ValidBody() body: z.infer<typeof CreateRoleAssignmentSchema>) {
    return this.assignments.grant(body);
  }

  @Delete(':assignmentId')
  @HttpCode(204)
  @Contract({
    operationId: 'access.assignment.revoke',
    tags: ACCESS,
    params: z.object({ assignmentId: uuid }),
    body: RevokeRoleAssignmentSchema,
    status: 204,
    permission: 'access.assignment.revoke',
    scope: { kind: 'tenant' },
    examples: { params: { assignmentId: 'assignmentId' }, body: { reason: 'left' } },
  })
  revoke(
    @ValidParams() params: { assignmentId: string },
    @ValidBody() body: z.infer<typeof RevokeRoleAssignmentSchema>,
  ) {
    return this.assignments.revoke(params.assignmentId, body.reason);
  }
}

@Controller('api-clients')
export class ApiClientsController {
  constructor(private readonly clients: ClientAuthService) {}

  @Get()
  @Contract({
    operationId: 'access.api_client.list',
    tags: ACCESS,
    response: z.array(ApiClientSchema),
    permission: 'access.api_client.manage',
    scope: { kind: 'tenant' },
  })
  list() {
    return this.clients.list();
  }

  @Post()
  @Contract({
    operationId: 'access.api_client.create',
    tags: ACCESS,
    body: CreateApiClientSchema,
    response: ApiClientCreatedSchema,
    permission: 'access.api_client.manage',
    scope: { kind: 'tenant' },
    idempotent: true,
    examples: { body: { name: 'Integration', scopes: ['tenancy.location.view'] } },
  })
  create(@ValidBody() body: z.infer<typeof CreateApiClientSchema>) {
    return this.clients.create(body);
  }

  @Post(':apiClientId/revoke')
  @HttpCode(200)
  @Contract({
    operationId: 'access.api_client.revoke',
    tags: ACCESS,
    params: z.object({ apiClientId: uuid }),
    response: ApiClientSchema,
    status: 200,
    permission: 'access.api_client.manage',
    scope: { kind: 'tenant' },
    idempotent: true,
    examples: { params: { apiClientId: 'apiClientId' } },
  })
  revoke(@ValidParams() params: { apiClientId: string }) {
    return this.clients.revoke(params.apiClientId);
  }
}

@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @Contract({
    operationId: 'approvals.list',
    tags: ['approvals'],
    query: z.object({
      locationId: uuid.optional(),
      status: ApprovalStatusSchema.default('pending'),
    }),
    response: z.array(ApprovalRequestSchema),
    permission: 'approvals.view',
    examples: { query: { locationId: '$fixture:locationId' } },
  })
  list(@ValidQuery() query: { locationId?: string; status: z.infer<typeof ApprovalStatusSchema> }) {
    return this.approvals.listPending(query.locationId, query.status);
  }

  @Post()
  @Contract({
    operationId: 'approvals.create',
    tags: ['approvals'],
    body: CreateApprovalSchema,
    response: ApprovalRequestSchema,
    permission: 'approvals.request',
    scope: { kind: 'dynamic', from: 'body', scopeKind: 'location', idField: 'locationId' },
    idempotent: true,
    examples: {
      body: {
        kind: 'discount_over_limit',
        locationId: '$fixture:locationId',
        subjectKind: 'order_line',
        payload: {
          permission: 'orders.discount.apply',
          attributes: { 'orders.discount.max_percent': 25 },
        },
      },
    },
  })
  create(@ValidBody() body: z.infer<typeof CreateApprovalSchema>) {
    return this.approvals.create(body);
  }

  @Get(':approvalId')
  @Contract({
    operationId: 'approvals.get',
    tags: ['approvals'],
    params: z.object({ approvalId: uuid }),
    response: ApprovalRequestSchema,
    permission: 'approvals.view',
    scope: { kind: 'tenant' },
    examples: { params: { approvalId: 'approvalId' } },
  })
  get(@ValidParams() params: { approvalId: string }) {
    return this.approvals.get(params.approvalId);
  }

  @Post(':approvalId/approve')
  @HttpCode(200)
  @Contract({
    operationId: 'approvals.approve',
    tags: ['approvals'],
    params: z.object({ approvalId: uuid }),
    body: DecideApprovalSchema,
    response: ApprovalRequestSchema,
    status: 200,
    permission: 'approvals.approve',
    scope: { kind: 'tenant' },
    idempotent: true,
    examples: { params: { approvalId: 'approvalId' }, body: { note: 'ok' } },
  })
  approve(
    @ValidParams() params: { approvalId: string },
    @ValidBody() body: z.infer<typeof DecideApprovalSchema>,
  ) {
    return this.approvals.decide(params.approvalId, 'approved', body);
  }

  @Post(':approvalId/reject')
  @HttpCode(200)
  @Contract({
    operationId: 'approvals.reject',
    tags: ['approvals'],
    params: z.object({ approvalId: uuid }),
    body: DecideApprovalSchema,
    response: ApprovalRequestSchema,
    status: 200,
    permission: 'approvals.approve',
    scope: { kind: 'tenant' },
    idempotent: true,
    examples: { params: { approvalId: 'approvalId' }, body: { note: 'no' } },
  })
  reject(
    @ValidParams() params: { approvalId: string },
    @ValidBody() body: z.infer<typeof DecideApprovalSchema>,
  ) {
    return this.approvals.decide(params.approvalId, 'rejected', body);
  }

  @Post(':approvalId/consume')
  @HttpCode(200)
  @Contract({
    operationId: 'approvals.consume',
    summary: 'Mark an approved request as used by its action',
    tags: ['approvals'],
    params: z.object({ approvalId: uuid }),
    body: z.object({ payloadHash: z.string().length(64) }),
    response: ApprovalRequestSchema,
    status: 200,
    permission: 'approvals.request',
    scope: { kind: 'tenant' },
    idempotent: true,
    examples: { params: { approvalId: 'approvalId' }, body: { payloadHash: '0'.repeat(64) } },
  })
  consume(
    @ValidParams() params: { approvalId: string },
    @ValidBody() body: { payloadHash: string },
  ) {
    return this.approvals.consume(params.approvalId, body.payloadHash);
  }
}

void Patch;
