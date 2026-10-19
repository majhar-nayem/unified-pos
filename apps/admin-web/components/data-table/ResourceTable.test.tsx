import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ColumnDef } from '@tanstack/react-table';
import { describe, expect, it, vi } from 'vitest';

import { mockSession } from '@/test/session';

import { ResourceTable, RowLink } from './ResourceTable';
import type { CursorPaging } from './types';

vi.mock('@/lib/auth/session', () => ({ useSession: () => mockSession() }));

interface Row {
  id: string;
  name: string;
  kind: string;
}
const DATA: Row[] = [
  { id: '1', name: 'Cafe Bondi', kind: 'restaurant' },
  { id: '2', name: 'Store Newtown', kind: 'store' },
  { id: '3', name: 'Warehouse West', kind: 'warehouse' },
];
const COLUMNS = [
  { id: 'name', header: 'Name', accessorFn: (r: Row) => r.name },
  { id: 'kind', header: 'Kind', accessorFn: (r: Row) => r.kind },
] as unknown as ColumnDef<Row, never>[];

function renderTable(extra: Partial<React.ComponentProps<typeof ResourceTable<Row>>> = {}) {
  return render(
    <ResourceTable<Row>
      tableId="things"
      caption="Things"
      columns={COLUMNS}
      rows={DATA}
      getRowId={(r) => r.id}
      emptyTitle="No things yet"
      emptyDescription="Add one to begin."
      filters={[
        { id: 'q', label: 'Search', type: 'text' },
        {
          id: 'kind',
          label: 'Kind',
          type: 'select',
          options: [
            { value: 'store', label: 'Store' },
            { value: 'restaurant', label: 'Restaurant' },
          ],
        },
      ]}
      matches={(r, f) =>
        (!f.q || r.name.toLowerCase().includes(f.q.toLowerCase())) && (!f.kind || r.kind === f.kind)
      }
      {...extra}
    />,
  );
}

const bodyRows = () =>
  within(screen.getByRole('table', { name: 'Things' }))
    .getAllByRole('row')
    .slice(1);

describe('ResourceTable', () => {
  it('renders rows with a caption, column headers and a position footer', () => {
    renderTable();
    expect(bodyRows()).toHaveLength(3);
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByText('1–3 of 3')).toBeInTheDocument();
  });

  it('filters client-side, shows removable chips and an empty state that offers to clear them', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.type(screen.getByLabelText('Search'), 'zzz');
    expect(screen.getByText('Nothing matches these filters')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(bodyRows()).toHaveLength(3);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'store');
    expect(bodyRows()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Remove filter Kind' }));
    expect(bodyRows()).toHaveLength(3);
  });

  it('sorts when a sortable header is activated and exposes aria-sort', async () => {
    const user = userEvent.setup();
    renderTable();
    const header = screen.getByRole('columnheader', { name: /Name/ });
    await user.click(within(header).getByRole('button'));
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    expect(within(bodyRows()[0]!).getByText('Cafe Bondi')).toBeInTheDocument();
    await user.click(within(header).getByRole('button'));
    expect(header).toHaveAttribute('aria-sort', 'descending');
    expect(within(bodyRows()[0]!).getByText('Warehouse West')).toBeInTheDocument();
  });

  it('pages locally when rows are the whole set', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      name: `Row ${i}`,
      kind: 'store',
    }));
    renderTable({ rows: many });
    expect(bodyRows()).toHaveLength(25);
    expect(screen.getByText('1–25 of 30')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(bodyRows()).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  });

  it('delegates paging to the server cursor contract when given one', async () => {
    const user = userEvent.setup();
    const paging: CursorPaging = {
      pageIndex: 1,
      hasNext: true,
      fetching: false,
      onNext: vi.fn(),
      onPrev: vi.fn(),
      onReset: vi.fn(),
      pageSize: 25,
      onPageSize: vi.fn(),
    };
    renderTable({ paging, matches: undefined });
    expect(screen.getByText('Page 2 · 3 rows')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    await user.selectOptions(screen.getByLabelText('Rows per page'), '50');
    expect(paging.onNext).toHaveBeenCalledTimes(1);
    expect(paging.onPrev).toHaveBeenCalledTimes(1);
    expect(paging.onPageSize).toHaveBeenCalledWith(50);
  });

  it('tells the server about filter changes without filtering locally', async () => {
    const user = userEvent.setup();
    const onFiltersChange = vi.fn();
    renderTable({ matches: undefined, onFiltersChange });
    await user.type(screen.getByLabelText('Search'), 'a');
    expect(onFiltersChange).toHaveBeenLastCalledWith({ q: 'a' });
    expect(bodyRows()).toHaveLength(3);
  });

  it('shows the empty state with its action, and an error with retry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = renderTable({
      rows: [],
      emptyAction: <button type="button">Add thing</button>,
    });
    expect(screen.getByRole('heading', { name: 'No things yet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add thing' })).toBeInTheDocument();
    rerender(
      <ResourceTable<Row>
        tableId="things"
        caption="Things"
        columns={COLUMNS}
        rows={DATA}
        getRowId={(r) => r.id}
        emptyTitle="x"
        emptyDescription="x"
        error="Could not load"
        onRetry={onRetry}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalled();
    expect(screen.getByText('Could not load')).toBeInTheDocument();
  });

  it('saves, applies and deletes views per user in localStorage', async () => {
    const user = userEvent.setup();
    const { unmount } = renderTable();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'store');
    await user.type(screen.getByLabelText('Save current view as'), 'Stores only');
    await user.click(screen.getByRole('button', { name: 'Save view' }));
    const key = window.localStorage.key(0);
    expect(key).toBe(
      'pos-admin:views:0190a000-0000-7000-8000-000000000001:0190a000-0000-7000-8000-000000000002:things',
    );
    expect(JSON.parse(window.localStorage.getItem(key!)!)).toEqual([
      expect.objectContaining({ name: 'Stores only', filters: { kind: 'store' } }),
    ]);
    unmount();

    renderTable();
    expect(bodyRows()).toHaveLength(3);
    await user.selectOptions(screen.getByLabelText('Saved view'), 'Stores only');
    expect(bodyRows()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Delete view' }));
    expect(JSON.parse(window.localStorage.getItem(key!)!)).toEqual([]);
  });

  it('keeps working when localStorage throws', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    renderTable();
    await user.type(screen.getByLabelText('Save current view as'), 'x');
    await user.click(screen.getByRole('button', { name: 'Save view' }));
    expect(bodyRows()).toHaveLength(3);
    spy.mockRestore();
  });

  it('hides a column from the column menu', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByText('Columns'));
    await user.click(screen.getByRole('checkbox', { name: 'Kind' }));
    expect(screen.queryByRole('columnheader', { name: 'Kind' })).not.toBeInTheDocument();
  });

  it('moves focus between row links with the arrow keys', async () => {
    const user = userEvent.setup();
    const cols = [
      {
        id: 'name',
        header: 'Name',
        accessorFn: (r: Row) => r.name,
        cell: ({ row }: { row: { original: Row } }) => (
          <RowLink onClick={() => undefined}>{row.original.name}</RowLink>
        ),
      },
    ] as unknown as ColumnDef<Row, never>[];
    renderTable({ columns: cols });
    screen.getByRole('button', { name: 'Cafe Bondi' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Store Newtown' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('button', { name: 'Cafe Bondi' })).toHaveFocus();
  });
});
