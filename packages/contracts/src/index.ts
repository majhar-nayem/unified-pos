import { z } from 'zod';

export * from './tenancy.js';
export * from './identity.js';

export const API_VERSION = 'v1' as const;

/** Money on the wire: bigint minor units travel as integer strings (never JSON numbers). */
export const MoneySchema = z.object({
  amountMinor: z.string().regex(/^-?\d+$/, 'integer string in minor units'),
  currency: z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code'),
});
export type MoneyDto = z.infer<typeof MoneySchema>;

/** jsonb column schema for platform.tenants.settings (grows with Phase 1 F1). */
export const TenantSettingsSchema = z
  .object({
    receiptHeader: z.string().max(500).optional(),
    cashRoundingEnabled: z.boolean().default(true),
  })
  .partial();
export type TenantSettings = z.infer<typeof TenantSettingsSchema>;

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  time: z.string().datetime(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** One entry in a sync upload batch (docs/01-system-architecture.md §8.2). */
export const SyncCommandSchema = z.object({
  clientCommandId: z.string().uuid(),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  hlc: z.string().min(1),
  clientTime: z.string().datetime(),
});
export type SyncCommandDto = z.infer<typeof SyncCommandSchema>;

export const SyncBatchSchema = z.object({
  deviceId: z.string().uuid(),
  clientBatchId: z.string().uuid(),
  commands: z.array(SyncCommandSchema).max(500),
});
export type SyncBatchDto = z.infer<typeof SyncBatchSchema>;

/** Domain event names emitted by modules (docs/01-system-architecture.md §5). Grows per slice. */
export const EVENT_CATALOG = [
  'tenant.provisioned',
  'location.created',
  'config.changed',
  'business_day.closed',
  'order.placed',
  'order.completed',
  'order.voided',
  'payment.authorized',
  'payment.captured',
  'payment.failed',
  'inventory.movement.recorded',
  'device.enrolled',
  'device.revoked',
  'user.invited',
  'user.activated',
  'role_assignment.granted',
  'role_assignment.revoked',
  'approval.decided',
  'org_unit.reparented',
  'business_day.opened',
  'catalog.item.changed',
  'menu.published',
  'item.availability.changed',
  // Wave 1 integration checkpoint (18 Oct 2026): S-F3, S-F4, S-F5 event names
  'order.returned',
  'payment.reversed',
  'refund.succeeded',
  'pricing.price_list.changed',
  'pricing.promotion.changed',
  'pricing.coupon.changed',
] as const;
export type EventName = (typeof EVENT_CATALOG)[number];
// F2 (S-F2)
export * from './common.js';
export * from './catalog.js';
export * from './pricing.js';
export * from './payments.js';
export * from './price-engine.js';
export * from './promotions.js';
export * from './orders.js'; // F4 (S-F4)
