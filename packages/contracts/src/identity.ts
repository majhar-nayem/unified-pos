/**
 * Identity, authentication, access-control and approval DTOs for Phase 1 F1
 * (docs/01-system-architecture.md §6, docs/03-implementation-plan.md §5).
 */
import { z } from 'zod';

import { AssignmentScopeKindSchema, ScopeRefSchema, TenantSlugSchema } from './tenancy.js';

const uuid = z.string().uuid();
const isoInstant = z.string().datetime({ offset: true });
const email = z.string().email().max(254);
const displayName = z.string().min(1).max(200);
const password = z.string().min(12).max(256);
const base64 = z.string().regex(/^[A-Za-z0-9+/_-]+={0,2}$/, 'base64 or base64url');
/** Opaque WebAuthn JSON bodies are validated by the WebAuthn library on the server. */
const webauthnJson = z.record(z.string(), z.unknown());

export const PinSchema = z.string().regex(/^\d{4,8}$/, '4 to 8 digits');
export const TotpCodeSchema = z.string().regex(/^\d{6}$/, '6 digits');
/** Permission key shape (`resource.action`, see @pos/auth catalog). */
export const PermissionKeySchema = z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/);
export const LimitValueSchema = z.union([z.number(), z.boolean(), z.string(), z.array(z.string())]);
export const LimitsSchema = z.record(z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/), LimitValueSchema);
export type LimitsDto = z.infer<typeof LimitsSchema>;

// ---------------------------------------------------------------------------
// Tokens and login
// ---------------------------------------------------------------------------

export const TokenPairSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  /** Access token lifetime in seconds. */
  expiresIn: z.number().int().positive(),
});
export type TokenPair = z.infer<typeof TokenPairSchema>;

export const MFA_METHODS = ['totp', 'passkey'] as const;
export const MfaMethodSchema = z.enum(MFA_METHODS);

export const LoginRequestSchema = z.object({
  tenantSlug: TenantSlugSchema,
  email,
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('authenticated'), tokens: TokenPairSchema }),
  z.object({
    status: z.literal('mfa_required'),
    preauthToken: z.string().min(1),
    methods: z.array(MfaMethodSchema).min(1),
  }),
  z.object({ status: z.literal('mfa_enrollment_required'), preauthToken: z.string().min(1) }),
]);
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const TotpVerifyRequestSchema = z.object({ code: TotpCodeSchema });
export type TotpVerifyRequest = z.infer<typeof TotpVerifyRequestSchema>;

export const TotpEnrollResponseSchema = z.object({ otpauthUri: z.string().url() });
export type TotpEnrollResponse = z.infer<typeof TotpEnrollResponseSchema>;

export const PasskeyRegisterOptionsRequestSchema = z.object({
  label: z.string().max(100).optional(),
});
export type PasskeyRegisterOptionsRequest = z.infer<typeof PasskeyRegisterOptionsRequestSchema>;
export const PasskeyRegisterOptionsResponseSchema = webauthnJson;
export const PasskeyRegisterVerifyRequestSchema = z.object({
  label: z.string().max(100).optional(),
  response: webauthnJson,
});
export type PasskeyRegisterVerifyRequest = z.infer<typeof PasskeyRegisterVerifyRequestSchema>;

export const PasskeyAuthOptionsRequestSchema = z.object({
  tenantSlug: TenantSlugSchema.optional(),
  email: email.optional(),
});
export type PasskeyAuthOptionsRequest = z.infer<typeof PasskeyAuthOptionsRequestSchema>;
export const PasskeyAuthOptionsResponseSchema = webauthnJson;
export const PasskeyAuthVerifyRequestSchema = z.object({
  tenantSlug: TenantSlugSchema.optional(),
  response: webauthnJson,
});
export type PasskeyAuthVerifyRequest = z.infer<typeof PasskeyAuthVerifyRequestSchema>;

export const PinLoginRequestSchema = z.object({ userId: uuid, pin: PinSchema });
export type PinLoginRequest = z.infer<typeof PinLoginRequestSchema>;

export const RefreshRequestSchema = z.object({ refreshToken: z.string().min(1) });
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const ClientCredentialsRequestSchema = z.object({
  tenantSlug: TenantSlugSchema,
  clientId: z.string().min(1).max(128),
  clientSecret: z.string().min(1).max(256),
});
export type ClientCredentialsRequest = z.infer<typeof ClientCredentialsRequestSchema>;

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export const DEVICE_KINDS = [
  'pos',
  'kds',
  'cfd',
  'handheld',
  'kiosk',
  'store_hub',
  'admin_browser',
] as const;
export const DeviceKindSchema = z.enum(DEVICE_KINDS);
export const DEVICE_PLATFORMS = ['windows', 'android', 'ios', 'macos', 'linux', 'web'] as const;
export const DevicePlatformSchema = z.enum(DEVICE_PLATFORMS);
export const DEVICE_ENROLLMENT_STATUSES = ['pending', 'enrolled', 'revoked', 'wiped'] as const;

/** `<tenant-slug>.<code>`: the slug lets the device resolve the tenant before it has a token. */
export const EnrollmentCodeSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[A-Za-z0-9]{6,32}$/, '<slug>.<code>');

export const DeviceEnrollRequestSchema = z.object({
  enrollmentCode: EnrollmentCodeSchema,
  publicKey: base64,
  name: displayName,
  platform: DevicePlatformSchema,
  appVersion: z.string().min(1).max(50),
});
export type DeviceEnrollRequest = z.infer<typeof DeviceEnrollRequestSchema>;

export const DeviceSchema = z.object({
  id: uuid,
  tenantId: uuid,
  locationId: uuid,
  registerId: uuid.nullable(),
  kind: DeviceKindSchema,
  name: displayName,
  platform: DevicePlatformSchema.nullable(),
  appVersion: z.string().nullable(),
  enrollmentStatus: z.enum(DEVICE_ENROLLMENT_STATUSES),
  enrolledAt: isoInstant.nullable(),
  revokedAt: isoInstant.nullable(),
  lastSeenAt: isoInstant.nullable(),
});
export type DeviceDto = z.infer<typeof DeviceSchema>;

export const DeviceEnrollResponseSchema = z.object({
  device: DeviceSchema,
  tokens: TokenPairSchema,
});
export type DeviceEnrollResponse = z.infer<typeof DeviceEnrollResponseSchema>;

export const CreateEnrollmentCodeSchema = z.object({
  locationId: uuid,
  registerId: uuid.optional(),
  kind: DeviceKindSchema,
});
export type CreateEnrollmentCode = z.infer<typeof CreateEnrollmentCodeSchema>;

export const DeviceChallengeResponseSchema = z.object({ nonce: base64 });
export type DeviceChallengeResponse = z.infer<typeof DeviceChallengeResponseSchema>;

export const DeviceLoginRequestSchema = z.object({
  tenantId: uuid,
  deviceId: uuid,
  nonce: base64,
  /** Signature over the nonce with the device's enrolled private key (base64). */
  signature: base64,
});
export type DeviceLoginRequest = z.infer<typeof DeviceLoginRequestSchema>;

// ---------------------------------------------------------------------------
// Users and credentials
// ---------------------------------------------------------------------------

export const USER_STATUSES = ['invited', 'active', 'suspended', 'deactivated'] as const;
export const UserStatusSchema = z.enum(USER_STATUSES);

export const UserSchema = z.object({
  id: uuid,
  tenantId: uuid,
  email: email.nullable(),
  displayName,
  locale: z.string().nullable(),
  status: UserStatusSchema,
  mfaEnabled: z.boolean(),
  lastLoginAt: isoInstant.nullable(),
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
export type UserDto = z.infer<typeof UserSchema>;

export const CreateUserSchema = z.object({
  email: email.optional(),
  displayName,
  locale: z.string().max(16).optional(),
  password: password.optional(),
});
export type CreateUser = z.infer<typeof CreateUserSchema>;

export const UpdateUserSchema = z
  .object({
    email: email.nullable(),
    displayName,
    locale: z.string().max(16).nullable(),
    status: z.enum(['active', 'suspended', 'deactivated']),
  })
  .partial();
export type UpdateUser = z.infer<typeof UpdateUserSchema>;

export const InviteUserSchema = z.object({ email, displayName });
export type InviteUser = z.infer<typeof InviteUserSchema>;

export const AcceptInviteSchema = z.object({ token: z.string().min(1), password });
export type AcceptInvite = z.infer<typeof AcceptInviteSchema>;

export const SetPasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(256).optional(),
  newPassword: password,
});
export type SetPasswordRequest = z.infer<typeof SetPasswordRequestSchema>;

export const SetPinRequestSchema = z.object({ locationId: uuid, pin: PinSchema });
export type SetPinRequest = z.infer<typeof SetPinRequestSchema>;

export const CREDENTIAL_KINDS = ['password', 'passkey', 'totp', 'pos_pin'] as const;
export const CredentialSchema = z.object({
  id: uuid,
  userId: uuid,
  kind: z.enum(CREDENTIAL_KINDS),
  locationId: uuid.nullable(),
  label: z.string().nullable(),
  status: z.enum(['active', 'revoked']),
  createdAt: isoInstant,
  lastUsedAt: isoInstant.nullable(),
});
export type CredentialDto = z.infer<typeof CredentialSchema>;

export const SessionSchema = z.object({
  id: uuid,
  userId: uuid.nullable(),
  deviceId: uuid.nullable(),
  kind: z.string(),
  createdAt: isoInstant,
  expiresAt: isoInstant,
  lastSeenAt: isoInstant.nullable(),
});
export type SessionDto = z.infer<typeof SessionSchema>;

// ---------------------------------------------------------------------------
// Roles, assignments, limits
// ---------------------------------------------------------------------------

export const RoleKeySchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'snake_case key');

export const RoleSchema = z.object({
  id: uuid,
  tenantId: uuid.nullable(),
  key: RoleKeySchema,
  name: displayName,
  description: z.string().nullable(),
  isSystem: z.boolean(),
  permissions: z.array(PermissionKeySchema),
  limits: LimitsSchema,
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
export type RoleDto = z.infer<typeof RoleSchema>;

export const CreateRoleSchema = z.object({
  key: RoleKeySchema,
  name: displayName,
  description: z.string().max(500).optional(),
  permissions: z.array(PermissionKeySchema).optional(),
  limits: LimitsSchema.optional(),
});
export type CreateRole = z.infer<typeof CreateRoleSchema>;

/** Clone a (system or tenant) role into a new tenant role with the given key and name. */
export const CloneRoleSchema = z.object({ key: RoleKeySchema, name: displayName });
export type CloneRole = z.infer<typeof CloneRoleSchema>;

export const UpdateRolePermissionsSchema = z.object({
  permissions: z.array(PermissionKeySchema),
});
export type UpdateRolePermissions = z.infer<typeof UpdateRolePermissionsSchema>;

export const RoleLimitsSchema = z.object({ limits: LimitsSchema });
export type RoleLimits = z.infer<typeof RoleLimitsSchema>;

export const RoleAssignmentSchema = z.object({
  id: uuid,
  tenantId: uuid,
  userId: uuid,
  roleId: uuid,
  roleKey: RoleKeySchema,
  scope: z.object({ kind: AssignmentScopeKindSchema, id: uuid }),
  validFrom: isoInstant,
  validTo: isoInstant.nullable(),
  grantedBy: uuid.nullable(),
  reason: z.string().nullable(),
  limits: LimitsSchema,
  createdAt: isoInstant,
});
export type RoleAssignmentDto = z.infer<typeof RoleAssignmentSchema>;

export const CreateRoleAssignmentSchema = z
  .object({
    userId: uuid,
    roleId: uuid,
    scope: ScopeRefSchema.extend({ kind: AssignmentScopeKindSchema }),
    validFrom: isoInstant.optional(),
    validTo: isoInstant.optional(),
    reason: z.string().max(500).optional(),
    limits: LimitsSchema.optional(),
  })
  .refine(
    (v) =>
      v.validFrom === undefined ||
      v.validTo === undefined ||
      Date.parse(v.validTo) > Date.parse(v.validFrom),
    { message: 'validTo must be after validFrom', path: ['validTo'] },
  );
export type CreateRoleAssignment = z.infer<typeof CreateRoleAssignmentSchema>;

export const RevokeRoleAssignmentSchema = z.object({ reason: z.string().max(500).optional() });
export type RevokeRoleAssignment = z.infer<typeof RevokeRoleAssignmentSchema>;

export const ApiClientSchema = z.object({
  id: uuid,
  tenantId: uuid,
  name: displayName,
  clientId: z.string(),
  scopes: z.array(z.string()),
  locationScope: z.array(uuid).nullable(),
  rateLimitPerMinute: z.number().int().positive(),
  status: z.enum(['active', 'revoked']),
  createdAt: isoInstant,
  lastUsedAt: isoInstant.nullable(),
});
export type ApiClientDto = z.infer<typeof ApiClientSchema>;

export const CreateApiClientSchema = z.object({
  name: displayName,
  scopes: z.array(PermissionKeySchema).min(1),
  locationScope: z.array(uuid).optional(),
  rateLimitPerMinute: z.number().int().positive().max(100000).optional(),
});
export type CreateApiClient = z.infer<typeof CreateApiClientSchema>;

/** Returned once, on creation: the secret is never shown again. */
export const ApiClientCreatedSchema = z.object({
  client: ApiClientSchema,
  clientSecret: z.string().min(1),
});
export type ApiClientCreated = z.infer<typeof ApiClientCreatedSchema>;

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'consumed',
] as const;
export const ApprovalStatusSchema = z.enum(APPROVAL_STATUSES);
export const ApprovalKindSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'snake_case kind');

export const ApprovalRequestSchema = z.object({
  id: uuid,
  tenantId: uuid,
  locationId: uuid.nullable(),
  kind: ApprovalKindSchema,
  subjectKind: z.string(),
  subjectId: uuid.nullable(),
  payload: z.record(z.string(), z.unknown()),
  payloadHash: z.string(),
  requestedBy: uuid,
  requestedAt: isoInstant,
  deviceId: uuid.nullable(),
  status: ApprovalStatusSchema,
  decidedBy: uuid.nullable(),
  decidedAt: isoInstant.nullable(),
  decisionNote: z.string().nullable(),
  expiresAt: isoInstant,
});
export type ApprovalRequestDto = z.infer<typeof ApprovalRequestSchema>;

export const CreateApprovalSchema = z.object({
  kind: ApprovalKindSchema,
  locationId: uuid.optional(),
  subjectKind: z.string().min(1).max(64),
  subjectId: uuid.optional(),
  payload: z.record(z.string(), z.unknown()),
});
export type CreateApproval = z.infer<typeof CreateApprovalSchema>;

/** Second factor presented by the approver at the register (manager PIN or passkey). */
export const ApprovalFactorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pin'), userId: uuid, pin: PinSchema }),
  z.object({ kind: z.literal('passkey'), response: webauthnJson }),
]);
export type ApprovalFactor = z.infer<typeof ApprovalFactorSchema>;

export const DecideApprovalSchema = z.object({
  note: z.string().max(500).optional(),
  factor: ApprovalFactorSchema.optional(),
});
export type DecideApproval = z.infer<typeof DecideApprovalSchema>;

// ---------------------------------------------------------------------------
// Principal (GET /auth/me)
// ---------------------------------------------------------------------------

export const PrincipalAssignmentDtoSchema = z.object({
  assignmentId: uuid,
  role: RoleKeySchema,
  permissions: z.array(PermissionKeySchema),
  scope: z.object({ kind: AssignmentScopeKindSchema, id: uuid }),
  coveredScopeIds: z.array(uuid),
  validFrom: isoInstant.optional(),
  validTo: isoInstant.optional(),
  limits: LimitsSchema.optional(),
});
export type PrincipalAssignmentDto = z.infer<typeof PrincipalAssignmentDtoSchema>;

export const PrincipalDtoSchema = z.object({
  tenantId: uuid,
  subjectId: uuid,
  kind: z.enum(['user', 'device', 'api_client']),
  sessionId: uuid.optional(),
  deviceId: uuid.optional(),
  locationId: uuid.optional(),
  mfaVerified: z.boolean(),
  mfaRequired: z.boolean(),
  assignmentsVersion: z.number().int().nonnegative(),
  assignments: z.array(PrincipalAssignmentDtoSchema),
  /** Union of permission keys over all active assignments, for client UI gating. */
  permissions: z.array(PermissionKeySchema),
});
export type PrincipalDto = z.infer<typeof PrincipalDtoSchema>;
