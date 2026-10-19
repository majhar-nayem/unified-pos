import { z } from 'zod';

/** Audit DTOs live here until F2 promotes them to @pos/contracts. */
export const AuditListQuerySchema = z.object({
  resourceKind: z.string().min(1).max(64).optional(),
  resourceId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
  action: z.string().min(1).max(128).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  /** Exclusive: return rows with seq > cursor. */
  cursor: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditListQuery = z.infer<typeof AuditListQuerySchema>;

export const AuditEntrySchema = z.object({
  id: z.string().uuid(),
  seq: z.number().int(),
  actorKind: z.enum(['user', 'device', 'system', 'api_client', 'operator']),
  actorId: z.string().uuid().nullable(),
  onBehalfOf: z.string().uuid().nullable(),
  deviceId: z.string().uuid().nullable(),
  locationId: z.string().uuid().nullable(),
  action: z.string(),
  resourceKind: z.string(),
  resourceId: z.string().uuid().nullable(),
  before: z.unknown(),
  after: z.unknown(),
  reason: z.string().nullable(),
  approvalId: z.string().uuid().nullable(),
  correlationId: z.string().nullable(),
  prevHash: z.string().nullable(),
  hash: z.string(),
  occurredAt: z.string().datetime({ offset: true }),
});
export type AuditEntryDto = z.infer<typeof AuditEntrySchema>;

export const AuditPageSchema = z.object({
  items: z.array(AuditEntrySchema),
  nextCursor: z.number().int().nullable(),
});
export type AuditPage = z.infer<typeof AuditPageSchema>;

export const ChainVerificationSchema = z.object({
  ok: z.boolean(),
  checked: z.number().int(),
  firstBrokenSeq: z.number().int().optional(),
  headMatches: z.boolean(),
  headSeq: z.number().int().nullable(),
});

export const ChainHeadSchema = z.object({
  headSeq: z.number().int().nullable(),
  headHash: z.string().nullable(),
  anchoredAt: z.string().datetime({ offset: true }).nullable(),
  updatedAt: z.string().datetime({ offset: true }).nullable(),
});
