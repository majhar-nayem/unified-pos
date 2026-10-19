import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { Pool } from '@pos/db';
import {
  BusinessDaySchema,
  CalendarDateSchema,
  ConfigEntrySchema,
  ConfigQuerySchema,
  ConfigResolvedSchema,
  CreateDepartmentSchema,
  CreateLegalEntitySchema,
  CreateLocationSchema,
  CreateOrgUnitSchema,
  CreateRegisterSchema,
  DepartmentSchema,
  LegalEntitySchema,
  LocationSchema,
  OpenBusinessDaySchema,
  OrgUnitSchema,
  PutConfigSchema,
  RegisterSchema,
  ReparentOrgUnitSchema,
  TenantSchema,
  UpdateLegalEntitySchema,
  UpdateLocationSchema,
  UpdateOrgUnitSchema,
  UpdateRegisterSchema,
} from '@pos/contracts';
import { z } from 'zod';

import {
  Contract,
  IfMatch,
  NotFoundError,
  PG_POOL,
  RequestContextService,
  ValidBody,
  ValidParams,
  ValidQuery,
} from '../kernel/public/index.js';
import { BusinessDaysService } from './business-days.service.js';
import { ConfigService } from './config.service.js';
import { LegalEntitiesService } from './legal-entities.service.js';
import { LocationsService } from './locations.service.js';
import { OrgUnitsService } from './org-units.service.js';
import { RegistersService } from './registers.service.js';
import { type TenantRow, toTenantDto } from './rows.js';

const uuid = z.string().uuid();
const TAGS = ['tenancy'] as const;

@Controller('tenants')
export class TenantsController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly context: RequestContextService,
  ) {}

  @Get('me')
  @Contract({
    operationId: 'tenancy.tenant.me',
    summary: 'The caller’s tenant',
    tags: TAGS,
    response: TenantSchema,
    permission: 'tenancy.tenant.view',
    scope: { kind: 'tenant' },
  })
  async me() {
    const tenantId = this.context.require().tenantId;
    // platform.tenants has no RLS: the predicate is the verified tenant id from the token, nothing else.
    const result = await this.pool.query<TenantRow>(
      'SELECT * FROM platform.tenants WHERE id = $1',
      [tenantId],
    );
    if (!result.rows[0]) throw new NotFoundError();
    return toTenantDto(result.rows[0]);
  }
}

@Controller('org-units')
export class OrgUnitsController {
  constructor(private readonly orgUnits: OrgUnitsService) {}

  @Get()
  @Contract({
    operationId: 'tenancy.org_unit.list',
    tags: TAGS,
    response: z.array(OrgUnitSchema),
    permission: 'tenancy.org_unit.view',
  })
  list() {
    return this.orgUnits.list();
  }

  @Post()
  @Contract({
    operationId: 'tenancy.org_unit.create',
    tags: TAGS,
    body: CreateOrgUnitSchema,
    response: OrgUnitSchema,
    permission: 'tenancy.org_unit.manage',
    idempotent: true,
    examples: {
      body: {
        parentId: '$fixture:rootOrgUnitId',
        kind: 'region',
        code: 'new-region',
        name: 'New region',
      },
    },
  })
  create(@ValidBody() body: z.infer<typeof CreateOrgUnitSchema>) {
    return this.orgUnits.create(body);
  }

  @Get(':orgUnitId')
  @Contract({
    operationId: 'tenancy.org_unit.get',
    tags: TAGS,
    params: z.object({ orgUnitId: uuid }),
    response: OrgUnitSchema,
    permission: 'tenancy.org_unit.view',
    scope: { kind: 'org_unit', param: 'orgUnitId' },
    examples: { params: { orgUnitId: 'childOrgUnitId' } },
  })
  get(@ValidParams() params: { orgUnitId: string }) {
    return this.orgUnits.get(params.orgUnitId);
  }

  @Patch(':orgUnitId')
  @Contract({
    operationId: 'tenancy.org_unit.update',
    tags: TAGS,
    params: z.object({ orgUnitId: uuid }),
    body: UpdateOrgUnitSchema,
    response: OrgUnitSchema,
    permission: 'tenancy.org_unit.manage',
    scope: { kind: 'org_unit', param: 'orgUnitId' },
    concurrency: 'if-match',
    examples: { params: { orgUnitId: 'childOrgUnitId' }, body: { name: 'Renamed' } },
  })
  update(
    @ValidParams() params: { orgUnitId: string },
    @ValidBody() body: z.infer<typeof UpdateOrgUnitSchema>,
    @IfMatch() version: number,
  ) {
    return this.orgUnits.update(params.orgUnitId, body, version);
  }

  @Post(':orgUnitId/reparent')
  @HttpCode(200)
  @Contract({
    operationId: 'tenancy.org_unit.reparent',
    tags: TAGS,
    params: z.object({ orgUnitId: uuid }),
    body: ReparentOrgUnitSchema,
    response: OrgUnitSchema,
    status: 200,
    permission: 'tenancy.org_unit.manage',
    scope: { kind: 'org_unit', param: 'orgUnitId' },
    idempotent: true,
    concurrency: 'if-match',
    examples: {
      params: { orgUnitId: 'childOrgUnitId' },
      body: { parentId: '$fixture:rootOrgUnitId' },
    },
  })
  reparent(
    @ValidParams() params: { orgUnitId: string },
    @ValidBody() body: z.infer<typeof ReparentOrgUnitSchema>,
    @IfMatch() version: number,
  ) {
    return this.orgUnits.reparent(params.orgUnitId, body, version);
  }
}

@Controller('legal-entities')
export class LegalEntitiesController {
  constructor(private readonly legalEntities: LegalEntitiesService) {}

  @Get()
  @Contract({
    operationId: 'tenancy.legal_entity.list',
    tags: TAGS,
    response: z.array(LegalEntitySchema),
    permission: 'tenancy.org_unit.view',
  })
  list() {
    return this.legalEntities.list();
  }

  @Post()
  @Contract({
    operationId: 'tenancy.legal_entity.create',
    tags: TAGS,
    body: CreateLegalEntitySchema,
    response: LegalEntitySchema,
    permission: 'tenancy.legal_entity.manage',
    scope: { kind: 'tenant' },
    idempotent: true,
    examples: {
      body: { name: 'Example Pty Ltd', countryCode: 'AU', registrationNumber: '12 345 678 901' },
    },
  })
  create(@ValidBody() body: z.infer<typeof CreateLegalEntitySchema>) {
    return this.legalEntities.create(body);
  }

  @Get(':legalEntityId')
  @Contract({
    operationId: 'tenancy.legal_entity.get',
    tags: TAGS,
    params: z.object({ legalEntityId: uuid }),
    response: LegalEntitySchema,
    permission: 'tenancy.org_unit.view',
    scope: { kind: 'tenant' },
  })
  get(@ValidParams() params: { legalEntityId: string }) {
    return this.legalEntities.get(params.legalEntityId);
  }

  @Patch(':legalEntityId')
  @Contract({
    operationId: 'tenancy.legal_entity.update',
    tags: TAGS,
    params: z.object({ legalEntityId: uuid }),
    body: UpdateLegalEntitySchema,
    response: LegalEntitySchema,
    permission: 'tenancy.legal_entity.manage',
    scope: { kind: 'tenant' },
    concurrency: 'if-match',
    examples: { body: { receiptLegalText: 'ABN 12 345 678 901' } },
  })
  update(
    @ValidParams() params: { legalEntityId: string },
    @ValidBody() body: z.infer<typeof UpdateLegalEntitySchema>,
    @IfMatch() version: number,
  ) {
    return this.legalEntities.update(params.legalEntityId, body, version);
  }
}

@Controller('locations')
export class LocationsController {
  constructor(
    private readonly locations: LocationsService,
    private readonly registers: RegistersService,
    private readonly businessDays: BusinessDaysService,
  ) {}

  @Get()
  @Contract({
    operationId: 'tenancy.location.list',
    summary: 'Locations the caller can reach',
    tags: TAGS,
    response: z.array(LocationSchema),
    permission: 'tenancy.location.view',
  })
  list() {
    return this.locations.list();
  }

  @Post()
  @Contract({
    operationId: 'tenancy.location.create',
    tags: TAGS,
    body: CreateLocationSchema,
    response: LocationSchema,
    permission: 'tenancy.location.manage',
    idempotent: true,
    examples: {
      body: {
        orgUnitId: '$fixture:rootOrgUnitId',
        code: 'new-store',
        name: 'New store',
        kind: 'store',
        timezone: 'Australia/Sydney',
        currency: 'AUD',
      },
    },
  })
  create(@ValidBody() body: z.infer<typeof CreateLocationSchema>) {
    return this.locations.create(body);
  }

  @Get(':locationId')
  @Contract({
    operationId: 'tenancy.location.get',
    tags: TAGS,
    params: z.object({ locationId: uuid }),
    response: LocationSchema,
    permission: 'tenancy.location.view',
    scope: { kind: 'location', param: 'locationId' },
  })
  get(@ValidParams() params: { locationId: string }) {
    return this.locations.get(params.locationId);
  }

  @Patch(':locationId')
  @Contract({
    operationId: 'tenancy.location.update',
    tags: TAGS,
    params: z.object({ locationId: uuid }),
    body: UpdateLocationSchema,
    response: LocationSchema,
    permission: 'tenancy.location.manage',
    scope: { kind: 'location', param: 'locationId' },
    concurrency: 'if-match',
    examples: { body: { name: 'Renamed store' } },
  })
  update(
    @ValidParams() params: { locationId: string },
    @ValidBody() body: z.infer<typeof UpdateLocationSchema>,
    @IfMatch() version: number,
  ) {
    return this.locations.update(params.locationId, body, version);
  }

  @Get(':locationId/departments')
  @Contract({
    operationId: 'tenancy.department.list',
    tags: TAGS,
    params: z.object({ locationId: uuid }),
    response: z.array(DepartmentSchema),
    permission: 'tenancy.location.view',
    scope: { kind: 'location', param: 'locationId' },
  })
  listDepartments(@ValidParams() params: { locationId: string }) {
    return this.locations.listDepartments(params.locationId);
  }

  @Post(':locationId/departments')
  @Contract({
    operationId: 'tenancy.department.create',
    tags: TAGS,
    params: z.object({ locationId: uuid }),
    body: CreateDepartmentSchema,
    response: DepartmentSchema,
    permission: 'tenancy.department.manage',
    scope: { kind: 'location', param: 'locationId' },
    idempotent: true,
    examples: { body: { code: 'bar', name: 'Bar', kind: 'bar' } },
  })
  createDepartment(
    @ValidParams() params: { locationId: string },
    @ValidBody() body: z.infer<typeof CreateDepartmentSchema>,
  ) {
    return this.locations.createDepartment(params.locationId, body);
  }

  @Get(':locationId/registers')
  @Contract({
    operationId: 'tenancy.register.list_by_location',
    tags: TAGS,
    params: z.object({ locationId: uuid }),
    response: z.array(RegisterSchema),
    permission: 'tenancy.register.view',
    scope: { kind: 'location', param: 'locationId' },
  })
  listRegisters(@ValidParams() params: { locationId: string }) {
    return this.registers.list(params.locationId);
  }

  @Post(':locationId/registers')
  @Contract({
    operationId: 'tenancy.register.create',
    tags: TAGS,
    params: z.object({ locationId: uuid }),
    body: CreateRegisterSchema,
    response: RegisterSchema,
    permission: 'tenancy.register.manage',
    scope: { kind: 'location', param: 'locationId' },
    idempotent: true,
    examples: { body: { code: 'R9', name: 'Register 9', kind: 'pos' } },
  })
  createRegister(
    @ValidParams() params: { locationId: string },
    @ValidBody() body: z.infer<typeof CreateRegisterSchema>,
  ) {
    return this.registers.create(params.locationId, body);
  }

  @Get(':locationId/business-days')
  @Contract({
    operationId: 'tenancy.business_day.list',
    tags: TAGS,
    params: z.object({ locationId: uuid }),
    response: z.array(BusinessDaySchema),
    permission: 'tenancy.location.view',
    scope: { kind: 'location', param: 'locationId' },
  })
  listBusinessDays(@ValidParams() params: { locationId: string }) {
    return this.businessDays.list(params.locationId);
  }

  @Post(':locationId/business-days/open')
  @Contract({
    operationId: 'tenancy.business_day.open',
    tags: TAGS,
    params: z.object({ locationId: uuid }),
    body: OpenBusinessDaySchema,
    response: BusinessDaySchema,
    permission: 'tenancy.business_day.open',
    scope: { kind: 'location', param: 'locationId' },
    idempotent: true,
    examples: { body: {} },
  })
  openBusinessDay(
    @ValidParams() params: { locationId: string },
    @ValidBody() body: z.infer<typeof OpenBusinessDaySchema>,
  ) {
    return this.businessDays.open(params.locationId, body.businessDate);
  }

  @Post(':locationId/business-days/close')
  @HttpCode(200)
  @Contract({
    operationId: 'tenancy.business_day.close',
    tags: TAGS,
    params: z.object({ locationId: uuid }),
    body: z.object({ businessDate: CalendarDateSchema }),
    response: BusinessDaySchema,
    status: 200,
    permission: 'tenancy.business_day.close',
    scope: { kind: 'location', param: 'locationId' },
    idempotent: true,
    examples: { body: { businessDate: '2026-10-18' } },
  })
  closeBusinessDay(
    @ValidParams() params: { locationId: string },
    @ValidBody() body: { businessDate: string },
  ) {
    return this.businessDays.close(params.locationId, body.businessDate);
  }
}

@Controller('registers')
export class RegistersController {
  constructor(private readonly registers: RegistersService) {}

  @Get()
  @Contract({
    operationId: 'tenancy.register.list',
    summary: 'Registers the caller can reach',
    tags: TAGS,
    response: z.array(RegisterSchema),
    permission: 'tenancy.register.view',
  })
  list() {
    return this.registers.list();
  }

  @Get(':registerId')
  @Contract({
    operationId: 'tenancy.register.get',
    tags: TAGS,
    params: z.object({ registerId: uuid }),
    response: RegisterSchema,
    permission: 'tenancy.register.view',
    scope: { kind: 'register', param: 'registerId' },
  })
  get(@ValidParams() params: { registerId: string }) {
    return this.registers.get(params.registerId);
  }

  @Patch(':registerId')
  @Contract({
    operationId: 'tenancy.register.update',
    tags: TAGS,
    params: z.object({ registerId: uuid }),
    body: UpdateRegisterSchema,
    response: RegisterSchema,
    permission: 'tenancy.register.manage',
    scope: { kind: 'register', param: 'registerId' },
    concurrency: 'if-match',
    examples: { body: { name: 'Front counter' } },
  })
  update(
    @ValidParams() params: { registerId: string },
    @ValidBody() body: z.infer<typeof UpdateRegisterSchema>,
    @IfMatch() version: number,
  ) {
    return this.registers.update(params.registerId, body, version);
  }
}

@Controller('config')
export class ConfigController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  @Contract({
    operationId: 'config.get_effective',
    summary: 'Effective value: nearest scope on the path wins',
    tags: ['config'],
    query: ConfigQuerySchema,
    response: ConfigResolvedSchema,
    permission: 'config.view',
    scope: { kind: 'dynamic', from: 'query', kindField: 'scopeKind', idField: 'scopeId' },
    examples: {
      query: { key: 'receipt.header', scopeKind: 'location', scopeId: '$fixture:locationId' },
    },
  })
  getEffective(@ValidQuery() query: z.infer<typeof ConfigQuerySchema>) {
    return this.config.getEffective(query.key, query.scopeKind, query.scopeId);
  }

  @Get('history')
  @Contract({
    operationId: 'config.history',
    tags: ['config'],
    query: ConfigQuerySchema,
    response: z.array(ConfigEntrySchema),
    permission: 'config.view',
    scope: { kind: 'dynamic', from: 'query', kindField: 'scopeKind', idField: 'scopeId' },
    examples: {
      query: { key: 'receipt.header', scopeKind: 'location', scopeId: '$fixture:locationId' },
    },
  })
  history(@ValidQuery() query: z.infer<typeof ConfigQuerySchema>) {
    return this.config.history(query.key, query.scopeKind, query.scopeId);
  }

  @Put()
  @Contract({
    operationId: 'config.put',
    summary: 'Set a value at a scope (new version)',
    tags: ['config'],
    body: PutConfigSchema,
    response: ConfigEntrySchema,
    permission: 'config.edit',
    scope: { kind: 'dynamic', from: 'body', kindField: 'scopeKind', idField: 'scopeId' },
    examples: {
      body: {
        key: 'receipt.header',
        scopeKind: 'location',
        scopeId: '$fixture:locationId',
        value: 'Thanks for shopping',
        reason: 'rebrand',
      },
    },
  })
  put(@ValidBody() body: z.infer<typeof PutConfigSchema>) {
    return this.config.put(body);
  }
}

// Silence unused-import lint for decorators only used in some controllers.
void Body;
void Param;
void Query;
