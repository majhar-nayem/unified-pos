import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  inet,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { bytea, citext } from './common.js';

/** Drizzle mirror of db/schema.sql (identity) + migration 0002 columns. */
export const identitySchema = pgSchema('identity');

export const users = identitySchema.table('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  email: citext('email'),
  displayName: text('display_name').notNull(),
  locale: text('locale'),
  status: text('status').notNull().default('active'),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  externalIdpSubject: text('external_idp_subject'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const userCredentials = identitySchema.table('user_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  kind: text('kind').notNull(),
  locationId: uuid('location_id'),
  secretHash: text('secret_hash'),
  publicKey: bytea('public_key'),
  credentialId: bytea('credential_id'),
  label: text('label'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  // migration 0002
  signCount: bigint('sign_count', { mode: 'bigint' }).notNull().default(0n),
  transports: text('transports').array(),
  aaguid: uuid('aaguid'),
  backedUp: boolean('backed_up'),
});

export const authSessions = identitySchema.table('auth_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  deviceId: uuid('device_id'),
  kind: text('kind').notNull(),
  refreshTokenHash: text('refresh_token_hash').notNull().unique(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokeReason: text('revoke_reason'),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  // migration 0002
  prevRefreshTokenHash: text('prev_refresh_token_hash'),
  mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true }),
  amr: text('amr').array().notNull().default([]),
  locationId: uuid('location_id'),
});

export const loginEvents = identitySchema.table('login_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id'),
  emailTried: citext('email_tried'),
  outcome: text('outcome').notNull(),
  method: text('method').notNull(),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  deviceId: uuid('device_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
});

export const permissions = identitySchema.table('permissions', {
  key: text('key').primaryKey(),
  module: text('module').notNull(),
  description: text('description').notNull(),
  isSensitive: boolean('is_sensitive').notNull().default(false),
});

export const roles = identitySchema.table('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id'),
  key: text('key').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  isSystem: boolean('is_system').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rolePermissions = identitySchema.table('role_permissions', {
  roleId: uuid('role_id').notNull(),
  permissionKey: text('permission_key').notNull(),
});

export const roleAssignments = identitySchema.table('role_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  roleId: uuid('role_id').notNull(),
  scopeKind: text('scope_kind').notNull(),
  scopeId: uuid('scope_id').notNull(),
  validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
  validTo: timestamp('valid_to', { withTimezone: true }),
  grantedBy: uuid('granted_by'),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const permissionLimits = identitySchema.table('permission_limits', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  roleId: uuid('role_id'),
  roleAssignmentId: uuid('role_assignment_id'),
  key: text('key').notNull(),
  value: jsonb('value').notNull(),
});

export const approvalRequests = identitySchema.table('approval_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  locationId: uuid('location_id'),
  kind: text('kind').notNull(),
  subjectKind: text('subject_kind').notNull(),
  subjectId: uuid('subject_id'),
  payload: jsonb('payload').notNull(),
  payloadHash: text('payload_hash').notNull(),
  requestedBy: uuid('requested_by').notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  deviceId: uuid('device_id'),
  status: text('status').notNull().default('pending'),
  decidedBy: uuid('decided_by'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionNote: text('decision_note'),
  expiresAt: timestamp('expires_at', { withTimezone: true })
    .notNull()
    .default(sql`now() + interval '15 minutes'`),
});

export const apiClients = identitySchema.table('api_clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  clientId: text('client_id').notNull().unique(),
  secretHash: text('secret_hash').notNull(),
  scopes: text('scopes').array().notNull().default([]),
  locationScope: uuid('location_scope').array(),
  rateLimitPerMinute: integer('rate_limit_per_minute').notNull().default(600),
  status: text('status').notNull().default('active'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});
