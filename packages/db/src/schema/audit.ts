import { sql } from 'drizzle-orm';
import {
  bigint,
  inet,
  integer,
  jsonb,
  pgSchema,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { bytea } from './common.js';

/** Drizzle mirror of db/schema_part3.sql (audit) + migration 0002 columns. */
export const auditSchema = pgSchema('audit');

export const auditLog = auditSchema.table('audit_log', {
  id: uuid('id').notNull().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  seq: bigint('seq', { mode: 'bigint' })
    .notNull()
    .default(sql`nextval('audit.audit_log_seq')`),
  actorKind: text('actor_kind').notNull(),
  actorId: uuid('actor_id'),
  onBehalfOf: uuid('on_behalf_of'),
  deviceId: uuid('device_id'),
  locationId: uuid('location_id'),
  action: text('action').notNull(),
  resourceKind: text('resource_kind').notNull(),
  resourceId: uuid('resource_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  reason: text('reason'),
  approvalId: uuid('approval_id'),
  correlationId: uuid('correlation_id'),
  ip: inet('ip'),
  prevHash: bytea('prev_hash'),
  hash: bytea('hash').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditChainHeads = auditSchema.table('audit_chain_heads', {
  tenantId: uuid('tenant_id').primaryKey(),
  headHash: bytea('head_hash').notNull(),
  headSeq: bigint('head_seq', { mode: 'bigint' }).notNull(),
  anchoredAt: timestamp('anchored_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const idempotencyKeys = auditSchema.table('idempotency_keys', {
  tenantId: uuid('tenant_id').notNull(),
  scope: text('scope').notNull(),
  key: text('key').notNull(),
  requestHash: text('request_hash').notNull(),
  responseStatus: smallint('response_status'),
  responseBody: jsonb('response_body'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true })
    .notNull()
    .default(sql`now() + interval '24 hours'`),
});

export const outboxEvents = auditSchema.table('outbox_events', {
  id: uuid('id').notNull().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  locationId: uuid('location_id'),
  aggregateKind: text('aggregate_kind').notNull(),
  aggregateId: uuid('aggregate_id').notNull(),
  aggregateVersion: integer('aggregate_version'),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').notNull(),
  headers: jsonb('headers').notNull().default({}),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  attempts: smallint('attempts').notNull().default(0),
  lastError: text('last_error'),
  // migration 0002
  claimedUntil: timestamp('claimed_until', { withTimezone: true }),
});

export const processedEvents = auditSchema.table('processed_events', {
  consumer: text('consumer').notNull(),
  eventId: uuid('event_id').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
});
