'use client';

import {
  type ColumnDef,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Alert, Spinner } from '@/components/ui/Misc';
import { useSession } from '@/lib/auth/session';
import {
  type SavedView,
  type ViewScope,
  deleteView,
  loadViews,
  upsertView,
} from '@/lib/saved-views';

import { FilterBar } from './FilterBar';
import type { CursorPaging, FilterDef, FilterValues } from './types';

export interface ResourceTableProps<T> {
  /** Stable id: scopes saved views and the accessible name. */
  tableId: string;
  caption: string;
  columns: ColumnDef<T, never>[];
  rows: readonly T[];
  getRowId(row: T): string;
  loading?: boolean;
  error?: string | null;
  onRetry?(): void;
  filters?: readonly FilterDef[];
  /** Client-side predicate when the data set is fully loaded. Server-filtered tables omit it. */
  matches?(row: T, filters: FilterValues): boolean;
  /** Called when filters change (server-filtered tables refetch here). */
  onFiltersChange?(filters: FilterValues): void;
  /** Server cursor paging; absent means the rows are the whole set and are paged locally. */
  paging?: CursorPaging;
  selectedId?: string | null;
  onOpen?(row: T): void;
  toolbar?: ReactNode;
  emptyTitle: string;
  emptyDescription: ReactNode;
  emptyAction?: ReactNode;
  filteredEmptyTitle?: string;
  /** Column ids hidden by default. */
  defaultHidden?: string[];
}

const LOCAL_PAGE_SIZES = [10, 25, 50, 100];

export function ResourceTable<T>(props: ResourceTableProps<T>) {
  const { tableId, caption, columns, rows, getRowId, loading, error, filters = [] } = props;
  const session = useSession();
  const tenantId = session.principal?.tenantId;
  const userId = session.principal?.subjectId;
  const scope = useMemo<ViewScope | null>(
    () => (tenantId && userId ? { tenantId, userId, tableId } : null),
    [tenantId, userId, tableId],
  );

  const [filterValues, setFilterValues] = useState<FilterValues>({});
  const [sorting, setSorting] = useState<SortingState>([]);
  const [visibility, setVisibility] = useState<VisibilityState>(
    Object.fromEntries((props.defaultHidden ?? []).map((id) => [id, false])),
  );
  const [density, setDensity] = useState<'compact' | 'comfortable'>('comfortable');
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewName, setViewName] = useState('');
  const [activeView, setActiveView] = useState('');
  const [localPage, setLocalPage] = useState(0);
  const [localSize, setLocalSize] = useState(25);

  useEffect(() => {
    if (scope) setViews(loadViews(scope));
  }, [scope]);

  const changeFilters = (next: FilterValues) => {
    setFilterValues(next);
    setLocalPage(0);
    setActiveView('');
    props.onFiltersChange?.(next);
  };

  const filtered = useMemo(
    () =>
      props.matches && Object.keys(filterValues).length > 0
        ? rows.filter((r) => props.matches!(r, filterValues))
        : rows,
    [rows, filterValues, props.matches],
  );

  const serverPaged = Boolean(props.paging);
  const pageRows = useMemo(
    () =>
      serverPaged ? filtered : filtered.slice(localPage * localSize, (localPage + 1) * localSize),
    [filtered, serverPaged, localPage, localSize],
  );

  const table = useReactTable({
    data: pageRows as T[],
    columns: columns as ColumnDef<T, unknown>[],
    state: { sorting, columnVisibility: visibility },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setVisibility,
    getRowId: (row) => getRowId(row),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const tbody = useRef<HTMLTableSectionElement>(null);
  const onRowKeyDown = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const links = Array.from(tbody.current?.querySelectorAll<HTMLElement>('.row-link') ?? []);
    const index = links.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    e.preventDefault();
    links[
      Math.min(links.length - 1, Math.max(0, index + (e.key === 'ArrowDown' ? 1 : -1)))
    ]?.focus();
  };

  const saveCurrentView = () => {
    const name = viewName.trim();
    if (!scope || !name) return;
    setViews(
      upsertView(scope, {
        name,
        filters: filterValues,
        sorting,
        columnVisibility: visibility,
        density,
        createdAt: new Date().toISOString(),
      }),
    );
    setActiveView(name);
    setViewName('');
  };
  const applyView = (name: string) => {
    setActiveView(name);
    const view = views.find((v) => v.name === name);
    if (!view) return;
    setFilterValues(view.filters);
    setSorting(view.sorting);
    setVisibility(view.columnVisibility);
    setDensity(view.density);
    setLocalPage(0);
    props.onFiltersChange?.(view.filters);
  };

  const hasFilter = Object.keys(filterValues).length > 0;
  const total = filtered.length;
  const from = serverPaged ? undefined : total === 0 ? 0 : localPage * localSize + 1;
  const to = serverPaged ? undefined : Math.min(total, (localPage + 1) * localSize);
  const allColumns = table.getAllLeafColumns();

  return (
    <section aria-label={caption}>
      {filters.length > 0 ? (
        <FilterBar defs={filters} values={filterValues} onChange={changeFilters} />
      ) : null}
      <div className="table-toolbar">
        <div className="field">
          <label className="field-label" htmlFor={`${tableId}-views`}>
            Saved view
          </label>
          <select
            id={`${tableId}-views`}
            className="input"
            value={activeView}
            onChange={(e) => applyView(e.target.value)}
          >
            <option value="">Default</option>
            {views.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`${tableId}-save`}>
            Save current view as
          </label>
          <input
            id={`${tableId}-save`}
            className="input"
            value={viewName}
            onChange={(e) => setViewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && saveCurrentView()}
          />
        </div>
        <Button size="sm" onClick={saveCurrentView} disabled={!viewName.trim()}>
          Save view
        </Button>
        {activeView ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (scope) setViews(deleteView(scope, activeView));
              setActiveView('');
            }}
          >
            Delete view
          </Button>
        ) : null}
        <div className="field">
          <label className="field-label" htmlFor={`${tableId}-density`}>
            Density
          </label>
          <select
            id={`${tableId}-density`}
            className="input"
            value={density}
            onChange={(e) => setDensity(e.target.value as 'compact' | 'comfortable')}
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </select>
        </div>
        <details className="field">
          <summary className="field-label" style={{ cursor: 'pointer' }}>
            Columns
          </summary>
          <div>
            {allColumns.map((col) => (
              <label key={col.id} style={{ display: 'flex', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={col.getIsVisible()}
                  onChange={col.getToggleVisibilityHandler()}
                />
                {typeof col.columnDef.header === 'string' ? col.columnDef.header : col.id}
              </label>
            ))}
          </div>
        </details>
        <div style={{ marginLeft: 'auto' }} className="inline">
          {props.toolbar}
        </div>
      </div>

      {error ? (
        <Alert tone="danger">
          {error}{' '}
          {props.onRetry ? (
            <Button size="sm" onClick={props.onRetry}>
              Retry
            </Button>
          ) : null}
        </Alert>
      ) : null}

      <div className="table-wrap">
        {loading && rows.length === 0 ? (
          <Spinner label={`Loading ${caption.toLowerCase()}`} />
        ) : total === 0 && !error ? (
          <EmptyState
            title={
              hasFilter
                ? (props.filteredEmptyTitle ?? 'Nothing matches these filters')
                : props.emptyTitle
            }
            description={
              hasFilter
                ? 'Remove a filter or clear them all to see every row.'
                : props.emptyDescription
            }
            action={
              hasFilter ? (
                <Button onClick={() => changeFilters({})}>Clear filters</Button>
              ) : (
                props.emptyAction
              )
            }
          />
        ) : (
          <div className="table-scroll">
            <table
              className="table"
              data-density={density}
              aria-label={caption}
              aria-busy={loading || props.paging?.fetching || undefined}
            >
              <thead>
                {table.getHeaderGroups().map((group) => (
                  <tr key={group.id}>
                    {group.headers.map((header) => {
                      const sortable = header.column.getCanSort();
                      const dir = header.column.getIsSorted();
                      return (
                        <th
                          key={header.id}
                          scope="col"
                          aria-sort={
                            dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined
                          }
                        >
                          {header.isPlaceholder ? null : sortable ? (
                            <button type="button" onClick={header.column.getToggleSortingHandler()}>
                              {flexRender(header.column.columnDef.header, header.getContext())}
                              <span aria-hidden="true">
                                {dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : ''}
                              </span>
                            </button>
                          ) : (
                            flexRender(header.column.columnDef.header, header.getContext())
                          )}
                        </th>
                      );
                    })}
                  </tr>
                ))}
              </thead>
              <tbody ref={tbody} onKeyDown={onRowKeyDown}>
                {table.getRowModel().rows.map((row) => (
                  <tr key={row.id} aria-selected={props.selectedId === row.id || undefined}>
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-footer">
          <span aria-live="polite">
            {serverPaged
              ? `Page ${(props.paging?.pageIndex ?? 0) + 1} · ${pageRows.length} rows${props.paging?.fetching ? ' · loading' : ''}`
              : `${from}–${to} of ${total}`}
          </span>
          <span className="inline">
            <label>
              Rows per page{' '}
              <select
                className="input"
                style={{ width: 'auto' }}
                value={props.paging?.pageSize ?? localSize}
                onChange={(e) => {
                  const size = Number(e.target.value);
                  if (props.paging) props.paging.onPageSize(size);
                  else {
                    setLocalSize(size);
                    setLocalPage(0);
                  }
                }}
              >
                {LOCAL_PAGE_SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <Button
              size="sm"
              onClick={() =>
                props.paging ? props.paging.onPrev() : setLocalPage((p) => Math.max(0, p - 1))
              }
              disabled={props.paging ? props.paging.pageIndex === 0 : localPage === 0}
            >
              Previous
            </Button>
            <Button
              size="sm"
              onClick={() => (props.paging ? props.paging.onNext() : setLocalPage((p) => p + 1))}
              disabled={props.paging ? !props.paging.hasNext : (localPage + 1) * localSize >= total}
            >
              Next
            </Button>
          </span>
        </div>
      </div>
    </section>
  );
}

/** Link-styled button for the first cell of a row: opens the detail drawer, keyboard reachable. */
export function RowLink({
  children,
  onClick,
  label,
}: {
  children: ReactNode;
  onClick(): void;
  label?: string;
}) {
  return (
    <button type="button" className="row-link" onClick={onClick} aria-label={label}>
      {children}
    </button>
  );
}
