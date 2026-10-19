/**
 * Tenancy + configuration DTOs for Phase 1 F1 (docs/03-implementation-plan.md §5).
 * Enum values mirror the CHECK constraints in db/schema.sql.
 */
import { z } from 'zod';

const uuid = z.string().uuid();
const isoInstant = z.string().datetime({ offset: true });
const code = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'letters, digits, _ and - only');
const name = z.string().min(1).max(200);

export const CurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code');
export const TimezoneSchema = z.string().min(1).max(64);
export const LocaleSchema = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'BCP 47 tag');
/** Time of day as HH:MM (24h). */
export const TimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
/** Calendar date as YYYY-MM-DD. */
export const CalendarDateSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

export const SCOPE_KINDS = ['tenant', 'org_unit', 'location', 'department', 'register'] as const;
export const ScopeKindSchema = z.enum(SCOPE_KINDS);
export type ScopeKind = z.infer<typeof ScopeKindSchema>;

/** Scope kinds a role assignment may target (identity.role_assignments.scope_kind). */
export const ASSIGNMENT_SCOPE_KINDS = ['tenant', 'org_unit', 'location', 'register'] as const;
export const AssignmentScopeKindSchema = z.enum(ASSIGNMENT_SCOPE_KINDS);

export const ScopeRefSchema = z.object({ kind: ScopeKindSchema, id: uuid });
export type ScopeRef = z.infer<typeof ScopeRefSchema>;

// ---------------------------------------------------------------------------
// Tenant
// ---------------------------------------------------------------------------

export const TENANT_STATUSES = ['provisioning', 'active', 'suspended', 'closed'] as const;
export const TenantSlugSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lowercase slug');

export const TenantSchema = z.object({
  id: uuid,
  slug: TenantSlugSchema,
  name,
  status: z.enum(TENANT_STATUSES),
  plan: z.string(),
  region: z.string(),
  defaultCurrency: CurrencyCodeSchema,
  defaultLocale: LocaleSchema,
  defaultTimezone: TimezoneSchema,
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
export type TenantDto = z.infer<typeof TenantSchema>;

export const ProvisionTenantRequestSchema = z.object({
  slug: TenantSlugSchema,
  name,
  region: z.string().min(1).max(32).optional(),
  defaultCurrency: CurrencyCodeSchema.optional(),
  defaultLocale: LocaleSchema.optional(),
  defaultTimezone: TimezoneSchema.optional(),
  admin: z.object({ email: z.string().email(), displayName: name }),
});
export type ProvisionTenantRequest = z.infer<typeof ProvisionTenantRequestSchema>;

// ---------------------------------------------------------------------------
// Org units
// ---------------------------------------------------------------------------

export const ORG_UNIT_KINDS = [
  'company',
  'brand',
  'region',
  'business_entity',
  'franchise_group',
  'division',
] as const;
export const OrgUnitKindSchema = z.enum(ORG_UNIT_KINDS);
export const ACTIVE_ARCHIVED = ['active', 'archived'] as const;

export const OrgUnitSchema = z.object({
  id: uuid,
  tenantId: uuid,
  parentId: uuid.nullable(),
  kind: OrgUnitKindSchema,
  code,
  name,
  legalEntityId: uuid.nullable(),
  reportingBoundary: z.boolean(),
  status: z.enum(ACTIVE_ARCHIVED),
  version: z.number().int().positive(),
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
export type OrgUnitDto = z.infer<typeof OrgUnitSchema>;

export const CreateOrgUnitSchema = z.object({
  parentId: uuid.nullable().optional(),
  kind: OrgUnitKindSchema,
  code,
  name,
  legalEntityId: uuid.nullable().optional(),
  reportingBoundary: z.boolean().optional(),
});
export type CreateOrgUnit = z.infer<typeof CreateOrgUnitSchema>;

export const UpdateOrgUnitSchema = z
  .object({
    kind: OrgUnitKindSchema,
    code,
    name,
    legalEntityId: uuid.nullable(),
    reportingBoundary: z.boolean(),
    status: z.enum(ACTIVE_ARCHIVED),
  })
  .partial();
export type UpdateOrgUnit = z.infer<typeof UpdateOrgUnitSchema>;

export const ReparentOrgUnitSchema = z.object({ parentId: uuid.nullable() });
export type ReparentOrgUnit = z.infer<typeof ReparentOrgUnitSchema>;

// ---------------------------------------------------------------------------
// Legal entities
// ---------------------------------------------------------------------------

export const AddressSchema = z
  .object({
    line1: z.string().max(200),
    line2: z.string().max(200),
    city: z.string().max(100),
    region: z.string().max(100),
    postcode: z.string().max(20),
    countryCode: z.string().regex(/^[A-Z]{2}$/),
  })
  .partial();
export type AddressDto = z.infer<typeof AddressSchema>;

export const LegalEntitySchema = z.object({
  id: uuid,
  tenantId: uuid,
  name,
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  registrationNumber: z.string().nullable(),
  taxRegistrationNumber: z.string().nullable(),
  address: AddressSchema,
  receiptLegalText: z.string().nullable(),
  status: z.enum(ACTIVE_ARCHIVED),
  version: z.number().int().positive(),
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
export type LegalEntityDto = z.infer<typeof LegalEntitySchema>;

export const CreateLegalEntitySchema = z.object({
  name,
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  registrationNumber: z.string().max(64).optional(),
  taxRegistrationNumber: z.string().max(64).optional(),
  address: AddressSchema.optional(),
  receiptLegalText: z.string().max(1000).optional(),
});
export type CreateLegalEntity = z.infer<typeof CreateLegalEntitySchema>;

export const UpdateLegalEntitySchema = z
  .object({
    name,
    countryCode: z.string().regex(/^[A-Z]{2}$/),
    registrationNumber: z.string().max(64).nullable(),
    taxRegistrationNumber: z.string().max(64).nullable(),
    address: AddressSchema,
    receiptLegalText: z.string().max(1000).nullable(),
    status: z.enum(ACTIVE_ARCHIVED),
  })
  .partial();
export type UpdateLegalEntity = z.infer<typeof UpdateLegalEntitySchema>;

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export const LOCATION_KINDS = [
  'store',
  'restaurant',
  'warehouse',
  'central_kitchen',
  'dark_store',
  'popup',
] as const;
export const LocationKindSchema = z.enum(LOCATION_KINDS);
export const DEPLOYMENT_PROFILES = ['cloud_only', 'device_autonomous', 'store_hub'] as const;
export const DeploymentProfileSchema = z.enum(DEPLOYMENT_PROFILES);
export const LOCATION_STATUSES = ['onboarding', 'active', 'closed', 'archived'] as const;

export const LocationSchema = z.object({
  id: uuid,
  tenantId: uuid,
  orgUnitId: uuid,
  legalEntityId: uuid.nullable(),
  code,
  name,
  kind: LocationKindSchema,
  deploymentProfile: DeploymentProfileSchema,
  timezone: TimezoneSchema,
  currency: CurrencyCodeSchema,
  locale: LocaleSchema,
  businessDayBoundary: TimeOfDaySchema,
  address: AddressSchema,
  status: z.enum(LOCATION_STATUSES),
  version: z.number().int().positive(),
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
export type LocationDto = z.infer<typeof LocationSchema>;

export const CreateLocationSchema = z.object({
  orgUnitId: uuid,
  legalEntityId: uuid.nullable().optional(),
  code,
  name,
  kind: LocationKindSchema,
  deploymentProfile: DeploymentProfileSchema.optional(),
  timezone: TimezoneSchema,
  currency: CurrencyCodeSchema,
  locale: LocaleSchema.optional(),
  businessDayBoundary: TimeOfDaySchema.optional(),
  address: AddressSchema.optional(),
});
export type CreateLocation = z.infer<typeof CreateLocationSchema>;

export const UpdateLocationSchema = z
  .object({
    orgUnitId: uuid,
    legalEntityId: uuid.nullable(),
    code,
    name,
    kind: LocationKindSchema,
    deploymentProfile: DeploymentProfileSchema,
    timezone: TimezoneSchema,
    currency: CurrencyCodeSchema,
    locale: LocaleSchema,
    businessDayBoundary: TimeOfDaySchema,
    address: AddressSchema,
    status: z.enum(LOCATION_STATUSES),
  })
  .partial();
export type UpdateLocation = z.infer<typeof UpdateLocationSchema>;

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

export const DEPARTMENT_KINDS = [
  'general',
  'retail',
  'restaurant',
  'bar',
  'bakery',
  'warehouse',
] as const;
export const DepartmentKindSchema = z.enum(DEPARTMENT_KINDS);

export const DepartmentSchema = z.object({
  id: uuid,
  tenantId: uuid,
  locationId: uuid,
  code,
  name,
  kind: DepartmentKindSchema,
  status: z.enum(ACTIVE_ARCHIVED),
  version: z.number().int().positive(),
});
export type DepartmentDto = z.infer<typeof DepartmentSchema>;

export const CreateDepartmentSchema = z.object({
  code,
  name,
  kind: DepartmentKindSchema.optional(),
});
export type CreateDepartment = z.infer<typeof CreateDepartmentSchema>;

// ---------------------------------------------------------------------------
// Registers
// ---------------------------------------------------------------------------

export const REGISTER_KINDS = ['pos', 'kiosk', 'handheld', 'online', 'virtual'] as const;
export const RegisterKindSchema = z.enum(REGISTER_KINDS);
export const REGISTER_STATUSES = ['active', 'disabled', 'archived'] as const;

export const RegisterSchema = z.object({
  id: uuid,
  tenantId: uuid,
  locationId: uuid,
  departmentId: uuid.nullable(),
  code,
  name,
  kind: RegisterKindSchema,
  status: z.enum(REGISTER_STATUSES),
  version: z.number().int().positive(),
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
export type RegisterDto = z.infer<typeof RegisterSchema>;

export const CreateRegisterSchema = z.object({
  departmentId: uuid.nullable().optional(),
  code,
  name,
  kind: RegisterKindSchema.optional(),
});
export type CreateRegister = z.infer<typeof CreateRegisterSchema>;

export const UpdateRegisterSchema = z
  .object({
    departmentId: uuid.nullable(),
    code,
    name,
    kind: RegisterKindSchema,
    status: z.enum(REGISTER_STATUSES),
  })
  .partial();
export type UpdateRegister = z.infer<typeof UpdateRegisterSchema>;

// ---------------------------------------------------------------------------
// Configuration (tenancy.config_entries; nearest scope on the path wins)
// ---------------------------------------------------------------------------

export const ConfigKeySchema = z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/, 'dotted config key');

export interface ConfigKeyDefinition {
  readonly schema: z.ZodType;
  readonly default: unknown;
  /** Scope kinds at which the key may be set. */
  readonly scopes: readonly ScopeKind[];
  readonly description: string;
}

const ALL_SCOPES: readonly ScopeKind[] = SCOPE_KINDS;

/** Registry of known configuration keys: the API validates PutConfig.value against `schema`. */
export const CONFIG_KEYS = {
  'receipt.header': {
    schema: z.string().max(500),
    default: '',
    scopes: ALL_SCOPES,
    description: 'Text printed at the top of receipts',
  },
  'cash.rounding.enabled': {
    schema: z.boolean(),
    default: true,
    scopes: ALL_SCOPES,
    description: 'Round cash tenders to the currency cash interval',
  },
  'identity.pin.max_attempts': {
    schema: z.number().int().min(1).max(20),
    default: 5,
    scopes: ['tenant', 'org_unit', 'location'],
    description: 'Failed PIN attempts allowed within the window before lockout',
  },
  'identity.pin.window_seconds': {
    schema: z.number().int().min(60).max(86400),
    default: 900,
    scopes: ['tenant', 'org_unit', 'location'],
    description: 'Sliding window (seconds) over which PIN attempts are counted',
  },
  'identity.pin.lock_seconds': {
    schema: z.number().int().min(60).max(86400),
    default: 900,
    scopes: ['tenant', 'org_unit', 'location'],
    description: 'Lockout duration (seconds) after too many failed PIN attempts',
  },
} as const satisfies Record<string, ConfigKeyDefinition>;
export type ConfigKey = keyof typeof CONFIG_KEYS;
export const CONFIG_KEY_NAMES = Object.keys(CONFIG_KEYS) as readonly ConfigKey[];

export const ConfigQuerySchema = z.object({
  key: ConfigKeySchema,
  scopeKind: ScopeKindSchema,
  scopeId: uuid,
});
export type ConfigQuery = z.infer<typeof ConfigQuerySchema>;

export const ConfigResolvedSchema = z.object({
  key: ConfigKeySchema,
  value: z.unknown(),
  /** The scope whose entry produced the value, or 'default' when nothing is set on the path. */
  resolvedScope: z.union([ScopeRefSchema, z.literal('default')]),
  version: z.number().int().positive().nullable(),
});
export type ConfigResolved = z.infer<typeof ConfigResolvedSchema>;

export const PutConfigSchema = z.object({
  key: ConfigKeySchema,
  scopeKind: ScopeKindSchema,
  scopeId: uuid,
  value: z.unknown(),
  reason: z.string().max(500).optional(),
});
export type PutConfig = z.infer<typeof PutConfigSchema>;

export const ConfigEntrySchema = z.object({
  id: uuid,
  tenantId: uuid,
  scopeKind: ScopeKindSchema,
  scopeId: uuid,
  key: ConfigKeySchema,
  value: z.unknown(),
  version: z.number().int().positive(),
  isCurrent: z.boolean(),
  effectiveFrom: isoInstant,
  createdBy: uuid.nullable(),
  createdAt: isoInstant,
  reason: z.string().nullable(),
});
export type ConfigEntryDto = z.infer<typeof ConfigEntrySchema>;

// ---------------------------------------------------------------------------
// Business days
// ---------------------------------------------------------------------------

export const BUSINESS_DAY_STATUSES = ['open', 'closing', 'closed'] as const;

export const BusinessDaySchema = z.object({
  tenantId: uuid,
  locationId: uuid,
  businessDate: CalendarDateSchema,
  status: z.enum(BUSINESS_DAY_STATUSES),
  openedAt: isoInstant,
  closedAt: isoInstant.nullable(),
  closedBy: uuid.nullable(),
});
export type BusinessDayDto = z.infer<typeof BusinessDaySchema>;

export const OpenBusinessDaySchema = z.object({
  /** Defaults to the location's current business date (businessDate() in domain-core). */
  businessDate: CalendarDateSchema.optional(),
});
export type OpenBusinessDay = z.infer<typeof OpenBusinessDaySchema>;
