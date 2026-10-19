import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';

import { cx } from '../../foundation/cx.js';
import { Icon } from '../../foundation/Icon.js';
import { useUi } from '../../foundation/UiProvider.js';
import { EmptyState } from '../EmptyState/EmptyState.js';
import { Skeleton } from '../Skeleton/Skeleton.js';

export type TableDensity = 'comfortable' | 'compact';
export type TableSortDirection = 'ascending' | 'descending';
export type TableSelectionMode = 'none' | 'single' | 'multiple';

export interface TableSort {
  readonly columnId: string;
  readonly direction: TableSortDirection;
}

export interface TableColumn<Row> {
  /** Stable id; also the sort key reported through `onSortChange`. */
  readonly id: string;
  readonly header: ReactNode;
  readonly cell: (row: Row, index: number) => ReactNode;
  readonly align?: 'start' | 'center' | 'end';
  /** px number or any CSS grid track size (`'2fr'`, `'minmax(120px, 1fr)'`). Default `minmax(0, 1fr)`. */
  readonly width?: number | string;
  /** Header becomes a sort control. The table does not sort rows itself: sort `rows` in response to `onSortChange`. */
  readonly sortable?: boolean;
}

export interface TableProps<Row> {
  readonly columns: readonly TableColumn<Row>[];
  readonly rows: readonly Row[];
  /** Stable row identity (selection, React keys). Defaults to the row index. */
  readonly getRowId?: (row: Row, index: number) => string;
  /** Viewport height in px. Required: the table windows its rows inside a fixed-height scroller. */
  readonly height: number;
  /** Fixed row height in px. Defaults to 40 (comfortable) or 32 (compact). */
  readonly rowHeight?: number;
  /** Extra rows rendered above and below the visible window. Default 4. */
  readonly overscan?: number;
  readonly density?: TableDensity;
  /** Shows static skeleton rows and marks the grid `aria-busy`. */
  readonly loading?: boolean;
  /** Rendered when `rows` is empty and not loading. Defaults to an EmptyState. */
  readonly empty?: ReactNode;
  /** Controlled sort. `null` = unsorted. */
  readonly sort?: TableSort | null;
  readonly defaultSort?: TableSort | null;
  readonly onSortChange?: (sort: TableSort | null) => void;
  readonly selectionMode?: TableSelectionMode;
  /** Controlled selection (row ids). */
  readonly selectedIds?: ReadonlySet<string>;
  readonly defaultSelectedIds?: ReadonlySet<string>;
  readonly onSelectionChange?: (ids: ReadonlySet<string>) => void;
  /** Called when a row is clicked or Enter is pressed on one of its cells. */
  readonly onRowClick?: (row: Row, index: number) => void;
  readonly 'aria-label'?: string;
  readonly 'aria-labelledby'?: string;
  readonly id?: string;
  readonly className?: string;
}

const ROW_HEIGHT: Record<TableDensity, number> = { comfortable: 40, compact: 32 };
const SKELETON_ROWS = 6;
const SELECT_COLUMN_WIDTH = 'var(--pos-space-3xl)';
const FALLBACK_COLUMN_PX = 120;

interface Position {
  /** 0 is the header row; data row i is at i + 1. */
  readonly row: number;
  readonly col: number;
}

function trackFor(column: TableColumn<unknown>): string {
  if (typeof column.width === 'number') return `${column.width}px`;
  return column.width ?? 'minmax(0, 1fr)';
}

/**
 * Virtualized data grid (ARIA `grid`). Rows are fixed height and windowed in-house, so only the visible
 * rows plus `overscan` exist in the DOM. One tab stop; arrows move between cells, Home/End jump within
 * a row (with Ctrl to the first/last row), PageUp/PageDown move a page, Enter activates the row, Space
 * toggles selection or sort.
 */
export function Table<Row>({
  columns,
  rows,
  getRowId,
  height,
  rowHeight,
  overscan = 4,
  density = 'comfortable',
  loading = false,
  empty,
  sort,
  defaultSort = null,
  onSortChange,
  selectionMode = 'none',
  selectedIds,
  defaultSelectedIds,
  onSelectionChange,
  onRowClick,
  className,
  id,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: TableProps<Row>) {
  const { t } = useUi();
  const statusId = useId();
  const itemHeight = rowHeight ?? ROW_HEIGHT[density];
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollTopRef = useRef(0);
  const pendingFocus = useRef(false);
  const [startIndex, setStartIndex] = useState(0);
  const [active, setActive] = useState<Position>({ row: 1, col: 0 });
  const [internalSort, setInternalSort] = useState<TableSort | null>(defaultSort);
  const [internalSelection, setInternalSelection] = useState<ReadonlySet<string>>(
    () => defaultSelectedIds ?? new Set<string>(),
  );

  const selectable = selectionMode !== 'none';
  const colOffset = selectable ? 1 : 0;
  const colCount = columns.length + colOffset;
  const total = rows.length;
  const showEmpty = !loading && total === 0;
  const bodyRowCount = loading ? SKELETON_ROWS : total;
  const maxRow = loading || showEmpty ? 0 : total;
  const currentSort = sort !== undefined ? sort : internalSort;
  const selection = selectedIds ?? internalSelection;
  const rowId = (row: Row, index: number) => (getRowId ? getRowId(row, index) : String(index));

  const activeRow = Math.min(active.row, maxRow);
  const activeCol = Math.min(active.col, Math.max(colCount - 1, 0));
  const activeDataIndex = activeRow - 1;

  // Visible window.
  const viewportRows = Math.max(1, Math.ceil((height - itemHeight) / itemHeight));
  const first = Math.max(0, Math.min(startIndex, Math.max(total - 1, 0)) - overscan);
  const last = Math.min(total - 1, startIndex + viewportRows + overscan);
  const rendered: number[] = [];
  if (!loading) {
    if (activeDataIndex >= 0 && activeDataIndex < first) rendered.push(activeDataIndex);
    for (let i = first; i <= last; i += 1) rendered.push(i);
    if (activeDataIndex > last && activeDataIndex < total) rendered.push(activeDataIndex);
  }

  function commitSort(next: TableSort | null) {
    if (sort === undefined) setInternalSort(next);
    onSortChange?.(next);
  }

  function toggleSort(column: TableColumn<Row>) {
    if (!column.sortable) return;
    if (currentSort?.columnId !== column.id)
      commitSort({ columnId: column.id, direction: 'ascending' });
    else if (currentSort.direction === 'ascending')
      commitSort({ columnId: column.id, direction: 'descending' });
    else commitSort(null);
  }

  function commitSelection(next: ReadonlySet<string>) {
    if (selectedIds === undefined) setInternalSelection(next);
    onSelectionChange?.(next);
  }

  function toggleRowSelection(index: number) {
    const row = rows[index];
    if (row === undefined || !selectable) return;
    const key = rowId(row, index);
    if (selectionMode === 'single') {
      commitSelection(selection.has(key) ? new Set<string>() : new Set([key]));
      return;
    }
    const next = new Set(selection);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    commitSelection(next);
  }

  const allSelected = total > 0 && rows.every((row, index) => selection.has(rowId(row, index)));
  const someSelected = !allSelected && rows.some((row, index) => selection.has(rowId(row, index)));

  function toggleAll() {
    commitSelection(
      allSelected ? new Set<string>() : new Set(rows.map((row, index) => rowId(row, index))),
    );
  }

  function scrollTo(top: number) {
    const clamped = Math.max(
      0,
      Math.min(top, Math.max(total * itemHeight - (height - itemHeight), 0)),
    );
    scrollTopRef.current = clamped;
    if (gridRef.current) gridRef.current.scrollTop = clamped;
    setStartIndex(Math.floor(clamped / itemHeight));
  }

  function revealRow(row: number) {
    if (row < 1) return;
    const top = (row - 1) * itemHeight;
    const viewport = height - itemHeight;
    const current = scrollTopRef.current;
    if (top < current) scrollTo(top);
    else if (top + itemHeight > current + viewport) scrollTo(top + itemHeight - viewport);
  }

  function moveTo(row: number, col: number) {
    const nextRow = Math.max(0, Math.min(row, maxRow));
    const nextCol = Math.max(0, Math.min(col, colCount - 1));
    pendingFocus.current = true;
    revealRow(nextRow);
    setActive({ row: nextRow, col: nextCol });
  }

  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    const cell = gridRef.current?.querySelector<HTMLElement>(
      `[data-row="${activeRow}"][data-col="${activeCol}"]`,
    );
    const target =
      cell?.dataset.kind === 'select' ? cell.querySelector<HTMLElement>('input') : cell;
    target?.focus({ preventScroll: true });
  });

  function cellOf(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element ? target.closest<HTMLElement>('[data-row][data-col]') : null;
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const cell = cellOf(event.target);
    if (!cell) return;
    // Only react when the cell itself (or its selection checkbox) has focus, not interactive cell content.
    const own =
      event.target === cell ||
      (cell.dataset.kind === 'select' && event.target instanceof HTMLInputElement);
    if (!own) return;
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    const page = Math.max(1, viewportRows - 1);
    const ctrl = event.ctrlKey || event.metaKey;
    const rtl = gridRef.current ? getComputedStyle(gridRef.current).direction === 'rtl' : false;
    let handled = true;
    switch (event.key) {
      case 'ArrowDown':
        moveTo(row + 1, col);
        break;
      case 'ArrowUp':
        moveTo(row - 1, col);
        break;
      case 'ArrowRight':
        moveTo(row, col + (rtl ? -1 : 1));
        break;
      case 'ArrowLeft':
        moveTo(row, col + (rtl ? 1 : -1));
        break;
      case 'Home':
        moveTo(ctrl ? 0 : row, 0);
        break;
      case 'End':
        moveTo(ctrl ? maxRow : row, colCount - 1);
        break;
      case 'PageDown':
        moveTo(row + page, col);
        break;
      case 'PageUp':
        moveTo(row - page, col);
        break;
      case 'Enter':
      case ' ': {
        if (event.target instanceof HTMLInputElement) {
          handled = false;
          break;
        }
        if (row === 0) {
          const column = columns[col - colOffset];
          if (column?.sortable) toggleSort(column);
          else handled = false;
        } else if (cell.dataset.kind === 'select') {
          if (event.key === ' ') toggleRowSelection(row - 1);
          else handled = false;
        } else if (event.key === 'Enter') {
          const data = rows[row - 1];
          if (data !== undefined && onRowClick) onRowClick(data, row - 1);
          else handled = false;
        } else if (selectable) {
          toggleRowSelection(row - 1);
        } else {
          handled = false;
        }
        break;
      }
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  }

  function onFocus(event: FocusEvent<HTMLDivElement>) {
    const cell = cellOf(event.target);
    if (!cell) return;
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    if (row !== activeRow || col !== activeCol) setActive({ row, col });
  }

  function onClick(event: MouseEvent<HTMLDivElement>) {
    const cell = cellOf(event.target);
    if (!cell || cell.dataset.kind === 'select') return;
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    // Ignore clicks that landed on interactive content inside the cell.
    const inner = (event.target as Element).closest(
      'button, a, input, select, textarea, [role="button"]',
    );
    if (inner && inner !== cell) return;
    if (row === 0) {
      const column = columns[col - colOffset];
      if (column) toggleSort(column);
      return;
    }
    const data = rows[row - 1];
    if (data !== undefined) onRowClick?.(data, row - 1);
  }

  const style = {
    height,
    '--pos-table-cols': [
      ...(selectable ? [SELECT_COLUMN_WIDTH] : []),
      ...columns.map((column) => trackFor(column as TableColumn<unknown>)),
    ].join(' '),
    '--pos-table-row-height': `${itemHeight}px`,
    '--pos-table-min-width': `${
      (selectable ? 48 : 0) +
      columns.reduce(
        (sum, column) =>
          sum + (typeof column.width === 'number' ? column.width : FALLBACK_COLUMN_PX),
        0,
      )
    }px`,
  } as CSSProperties;

  function alignOf(column: TableColumn<Row>) {
    return column.align ?? 'start';
  }

  return (
    <>
      {/* Status is a sibling of the grid: a live region cannot live inside role=grid. */}
      <span id={statusId} className="pos-sr-only" role="status">
        {loading ? t('ui.loading') : ''}
      </span>
      <div
        ref={gridRef}
        id={id}
        role="grid"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-rowcount={bodyRowCount + 1}
        aria-colcount={colCount}
        aria-multiselectable={selectionMode === 'multiple' ? true : undefined}
        aria-busy={loading || undefined}
        data-density={density}
        tabIndex={-1}
        className={cx('pos-table', className)}
        style={style}
        onScroll={(event) => {
          scrollTopRef.current = event.currentTarget.scrollTop;
          setStartIndex(Math.floor(event.currentTarget.scrollTop / itemHeight));
        }}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onClick={onClick}
      >
        <div role="rowgroup" className="pos-table__head">
          <div role="row" aria-rowindex={1} className="pos-table__row pos-table__row--head">
            {selectable ? (
              <div
                role="columnheader"
                aria-colindex={1}
                aria-label={t('table.selectColumn')}
                data-row={0}
                data-col={0}
                data-kind="select"
                className="pos-table__cell pos-table__cell--select"
              >
                {selectionMode === 'multiple' ? (
                  <input
                    type="checkbox"
                    className="pos-table__checkbox"
                    aria-label={t('table.selectAll')}
                    checked={allSelected}
                    disabled={total === 0}
                    tabIndex={activeRow === 0 && activeCol === 0 ? 0 : -1}
                    ref={(node) => {
                      if (node) node.indeterminate = someSelected;
                    }}
                    onChange={toggleAll}
                  />
                ) : (
                  <span className="pos-sr-only">{t('table.selectColumn')}</span>
                )}
              </div>
            ) : null}
            {columns.map((column, c) => {
              const col = c + colOffset;
              const sorted =
                currentSort?.columnId === column.id ? currentSort.direction : undefined;
              return (
                <div
                  key={column.id}
                  role="columnheader"
                  aria-colindex={col + 1}
                  aria-sort={column.sortable ? (sorted ?? 'none') : undefined}
                  data-row={0}
                  data-col={col}
                  data-align={alignOf(column)}
                  data-sortable={column.sortable ? '' : undefined}
                  tabIndex={activeRow === 0 && activeCol === col ? 0 : -1}
                  className="pos-table__cell pos-table__cell--head"
                >
                  <span className="pos-table__header-label">{column.header}</span>
                  {column.sortable ? (
                    <Icon
                      name={sorted === 'descending' ? 'arrow-down' : 'arrow-up'}
                      className={cx('pos-table__sort', !sorted && 'pos-table__sort--idle')}
                      size="1em"
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
        <div
          role="rowgroup"
          className="pos-table__body"
          style={showEmpty ? undefined : { height: bodyRowCount * itemHeight }}
        >
          {loading
            ? Array.from({ length: SKELETON_ROWS }, (_, i) => (
                <div
                  key={i}
                  role="row"
                  aria-rowindex={i + 2}
                  className="pos-table__row"
                  style={{ top: i * itemHeight, height: itemHeight }}
                >
                  {selectable ? (
                    <div
                      role="gridcell"
                      aria-colindex={1}
                      className="pos-table__cell pos-table__cell--select"
                    />
                  ) : null}
                  {columns.map((column, c) => (
                    <div
                      key={column.id}
                      role="gridcell"
                      aria-colindex={c + colOffset + 1}
                      className="pos-table__cell"
                    >
                      <Skeleton />
                    </div>
                  ))}
                </div>
              ))
            : null}
          {showEmpty ? (
            <div role="row" aria-rowindex={2} className="pos-table__row pos-table__row--empty">
              <div
                role="gridcell"
                aria-colindex={1}
                aria-colspan={Math.max(colCount, 1)}
                className="pos-table__cell pos-table__cell--empty"
              >
                {empty ?? <EmptyState title={t('table.empty')} />}
              </div>
            </div>
          ) : null}
          {rendered.map((i) => {
            const row = rows[i] as Row;
            const key = rowId(row, i);
            const isSelected = selectable && selection.has(key);
            const rowNumber = i + 1;
            return (
              <div
                key={key}
                role="row"
                aria-rowindex={i + 2}
                aria-selected={selectable ? isSelected : undefined}
                data-selected={isSelected ? '' : undefined}
                data-clickable={onRowClick ? '' : undefined}
                className="pos-table__row"
                style={{ top: i * itemHeight, height: itemHeight }}
              >
                {selectable ? (
                  <div
                    role="gridcell"
                    aria-colindex={1}
                    data-row={rowNumber}
                    data-col={0}
                    data-kind="select"
                    className="pos-table__cell pos-table__cell--select"
                  >
                    <input
                      type="checkbox"
                      className="pos-table__checkbox"
                      aria-label={t('table.selectRow', { row: rowNumber })}
                      checked={isSelected}
                      tabIndex={activeRow === rowNumber && activeCol === 0 ? 0 : -1}
                      onChange={() => toggleRowSelection(i)}
                    />
                  </div>
                ) : null}
                {columns.map((column, c) => {
                  const col = c + colOffset;
                  return (
                    <div
                      key={column.id}
                      role="gridcell"
                      aria-colindex={col + 1}
                      data-row={rowNumber}
                      data-col={col}
                      data-align={alignOf(column)}
                      tabIndex={activeRow === rowNumber && activeCol === col ? 0 : -1}
                      className="pos-table__cell"
                    >
                      {column.cell(row, i)}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
