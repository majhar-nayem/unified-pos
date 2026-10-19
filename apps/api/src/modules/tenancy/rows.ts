import type {
  BusinessDayDto,
  ConfigEntryDto,
  DepartmentDto,
  LegalEntityDto,
  LocationDto,
  OrgUnitDto,
  RegisterDto,
  TenantDto,
} from '@pos/contracts';

/** Row shapes (snake_case, as pg returns them) and mappers to the wire DTOs (camelCase, ISO dates). */

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: TenantDto['status'];
  plan: string;
  region: string;
  default_currency: string;
  default_locale: string;
  default_timezone: string;
  created_at: Date;
  updated_at: Date;
}

export function toTenantDto(r: TenantRow): TenantDto {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    status: r.status,
    plan: r.plan,
    region: r.region,
    defaultCurrency: r.default_currency.trim(),
    defaultLocale: r.default_locale,
    defaultTimezone: r.default_timezone,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export interface OrgUnitRow {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  kind: OrgUnitDto['kind'];
  code: string;
  name: string;
  legal_entity_id: string | null;
  reporting_boundary: boolean;
  status: OrgUnitDto['status'];
  version: number;
  created_at: Date;
  updated_at: Date;
}

export type OrgUnitOut = OrgUnitDto;

export function toOrgUnitDto(r: OrgUnitRow): OrgUnitOut {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    parentId: r.parent_id,
    kind: r.kind,
    code: r.code,
    name: r.name,
    legalEntityId: r.legal_entity_id,
    reportingBoundary: r.reporting_boundary,
    status: r.status,
    version: r.version,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export interface LegalEntityRow {
  id: string;
  tenant_id: string;
  name: string;
  country_code: string;
  registration_number: string | null;
  tax_registration_number: string | null;
  address: LegalEntityDto['address'];
  receipt_legal_text: string | null;
  status: LegalEntityDto['status'];
  version: number;
  created_at: Date;
  updated_at: Date;
}

export type LegalEntityOut = LegalEntityDto;

export function toLegalEntityDto(r: LegalEntityRow): LegalEntityOut {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    countryCode: r.country_code,
    registrationNumber: r.registration_number,
    taxRegistrationNumber: r.tax_registration_number,
    address: r.address ?? {},
    receiptLegalText: r.receipt_legal_text,
    status: r.status,
    version: r.version,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export interface LocationRow {
  id: string;
  tenant_id: string;
  org_unit_id: string;
  legal_entity_id: string | null;
  code: string;
  name: string;
  kind: LocationDto['kind'];
  deployment_profile: LocationDto['deploymentProfile'];
  timezone: string;
  currency: string;
  locale: string;
  business_day_boundary: string;
  address: LocationDto['address'];
  status: LocationDto['status'];
  version: number;
  created_at: Date;
  updated_at: Date;
}

export function toLocationDto(r: LocationRow): LocationDto {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    orgUnitId: r.org_unit_id,
    legalEntityId: r.legal_entity_id,
    code: r.code,
    name: r.name,
    kind: r.kind,
    deploymentProfile: r.deployment_profile,
    timezone: r.timezone,
    currency: r.currency.trim(),
    locale: r.locale,
    businessDayBoundary: r.business_day_boundary.slice(0, 5),
    address: r.address ?? {},
    status: r.status,
    version: r.version,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export interface DepartmentRow {
  id: string;
  tenant_id: string;
  location_id: string;
  code: string;
  name: string;
  kind: DepartmentDto['kind'];
  status: DepartmentDto['status'];
  version: number;
}

export type DepartmentOut = DepartmentDto;

export function toDepartmentDto(r: DepartmentRow): DepartmentOut {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    locationId: r.location_id,
    code: r.code,
    name: r.name,
    kind: r.kind,
    status: r.status,
    version: r.version,
  };
}

export interface RegisterRow {
  id: string;
  tenant_id: string;
  location_id: string;
  department_id: string | null;
  code: string;
  name: string;
  kind: RegisterDto['kind'];
  status: RegisterDto['status'];
  version: number;
  created_at: Date;
  updated_at: Date;
}

export function toRegisterDto(r: RegisterRow): RegisterDto {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    locationId: r.location_id,
    departmentId: r.department_id,
    code: r.code,
    name: r.name,
    kind: r.kind,
    status: r.status,
    version: r.version,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export interface ConfigEntryRow {
  id: string;
  tenant_id: string;
  scope_kind: ConfigEntryDto['scopeKind'];
  scope_id: string;
  key: string;
  value: unknown;
  version: number;
  is_current: boolean;
  effective_from: Date;
  created_by: string | null;
  created_at: Date;
  reason: string | null;
}

export function toConfigEntryDto(r: ConfigEntryRow): ConfigEntryDto {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    scopeKind: r.scope_kind,
    scopeId: r.scope_id,
    key: r.key,
    value: r.value,
    version: r.version,
    isCurrent: r.is_current,
    effectiveFrom: r.effective_from.toISOString(),
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    reason: r.reason,
  };
}

export interface BusinessDayRow {
  tenant_id: string;
  location_id: string;
  business_date: string;
  status: BusinessDayDto['status'];
  opened_at: Date;
  closed_at: Date | null;
  closed_by: string | null;
}

export function toBusinessDayDto(r: BusinessDayRow): BusinessDayDto {
  return {
    tenantId: r.tenant_id,
    locationId: r.location_id,
    businessDate:
      typeof r.business_date === 'string'
        ? r.business_date
        : new Date(r.business_date).toISOString().slice(0, 10),
    status: r.status,
    openedAt: r.opened_at.toISOString(),
    closedAt: r.closed_at ? r.closed_at.toISOString() : null,
    closedBy: r.closed_by,
  };
}

/** Build `SET a = $n, b = $m` from a camelCase patch using an explicit column map. */
export function buildPatch(
  patch: Record<string, unknown>,
  columns: Readonly<Record<string, string>>,
  startIndex = 1,
): { set: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [field, column] of Object.entries(columns)) {
    if (!(field in patch) || patch[field] === undefined) continue;
    params.push(column === 'address' ? JSON.stringify(patch[field]) : patch[field]);
    parts.push(`${column} = $${startIndex + params.length - 1}`);
  }
  return { set: parts.join(', '), params };
}
