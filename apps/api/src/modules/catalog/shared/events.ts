import type { TenantUnitOfWork } from '@pos/db';

export type CatalogChange = 'created' | 'updated' | 'deleted';

/**
 * Every catalog write emits `catalog.item.changed` (docs/01 §5 module 3 events) so device replicas
 * refresh. `entity` names the table-level aggregate; `itemId` is set whenever the change belongs
 * to one item so consumers can refresh just that item.
 */
export function emitCatalogChanged(
  uow: TenantUnitOfWork,
  input: {
    readonly entity: string;
    readonly entityId: string;
    readonly change: CatalogChange;
    readonly version?: number | null;
    readonly itemId?: string | null;
    readonly locationId?: string | null;
    readonly detail?: Record<string, unknown>;
  },
): void {
  uow.emit({
    type: 'catalog.item.changed',
    aggregateKind: input.entity,
    aggregateId: input.entityId,
    aggregateVersion: input.version ?? null,
    locationId: input.locationId ?? null,
    payload: {
      entity: input.entity,
      change: input.change,
      ...(input.itemId ? { itemId: input.itemId } : {}),
      ...(input.detail ?? {}),
    },
  });
}
