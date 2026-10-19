/**
 * Saved table views (design plan §3.2 DataTable): kept per user and table in localStorage. Nothing
 * here is authoritative; the server never sees a view.
 */
export interface SavedView {
  name: string;
  filters: Record<string, string>;
  sorting: { id: string; desc: boolean }[];
  columnVisibility: Record<string, boolean>;
  density: 'compact' | 'comfortable';
  createdAt: string;
}

export interface ViewScope {
  tenantId: string;
  userId: string;
  tableId: string;
}

export function viewsKey(scope: ViewScope): string {
  return `pos-admin:views:${scope.tenantId}:${scope.userId}:${scope.tableId}`;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadViews(scope: ViewScope): SavedView[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(viewsKey(scope));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as SavedView[]) : [];
  } catch {
    return [];
  }
}

export function saveViews(scope: ViewScope, views: SavedView[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(viewsKey(scope), JSON.stringify(views));
  } catch {
    // quota or privacy mode: views are a convenience only
  }
}

export function upsertView(scope: ViewScope, view: SavedView): SavedView[] {
  const views = loadViews(scope).filter((v) => v.name !== view.name);
  views.push(view);
  views.sort((a, b) => a.name.localeCompare(b.name));
  saveViews(scope, views);
  return views;
}

export function deleteView(scope: ViewScope, name: string): SavedView[] {
  const views = loadViews(scope).filter((v) => v.name !== name);
  saveViews(scope, views);
  return views;
}
