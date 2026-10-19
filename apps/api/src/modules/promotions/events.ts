import type { PricingEventName } from '@pos/contracts';
import type { TenantUnitOfWork } from '@pos/db';

export type PricingChange = 'created' | 'updated' | 'deleted';

/**
 * Every write emits one change event (docs/01-system-architecture.md §5 module 4) so device
 * replicas refresh price lists and promotions; `entity` names the table-level aggregate member.
 */
export function emitPricingChanged(
  uow: TenantUnitOfWork,
  type: PricingEventName,
  input: {
    readonly aggregateKind: string;
    readonly aggregateId: string;
    readonly version?: number | null;
    readonly entity: string;
    readonly entityId?: string;
    readonly change: PricingChange;
    readonly detail?: Record<string, unknown>;
  },
): void {
  uow.emit({
    type,
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    aggregateVersion: input.version ?? null,
    payload: {
      entity: input.entity,
      ...(input.entityId ? { entityId: input.entityId } : {}),
      change: input.change,
      ...(input.detail ?? {}),
    },
  });
}
