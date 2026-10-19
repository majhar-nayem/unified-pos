import { fireEvent, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { Table, type TableColumn, type TableSort } from './Table.js';

interface Item {
  readonly id: string;
  readonly name: string;
  readonly qty: number;
}

function makeItems(count: number): Item[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `r${i + 1}`,
    name: `Item ${i + 1}`,
    qty: i + 1,
  }));
}

const columns: TableColumn<Item>[] = [
  { id: 'name', header: 'Name', cell: (row) => row.name, sortable: true },
  { id: 'qty', header: 'Qty', cell: (row) => row.qty, align: 'end', width: 80 },
];

function renderTable(props: Partial<ComponentProps<typeof Table<Item>>> = {}) {
  return renderUi(
    <Table<Item>
      aria-label="Items"
      columns={columns}
      rows={makeItems(5)}
      height={200}
      getRowId={(row) => row.id}
      {...props}
    />,
  );
}

function dataRows(grid: HTMLElement) {
  return within(grid).getAllByRole('row').slice(1);
}

describe('Table', () => {
  it('has grid semantics with row, column counts and indexes', () => {
    renderTable();
    const grid = screen.getByRole('grid', { name: 'Items' });
    expect(grid).toHaveAttribute('aria-rowcount', '6');
    expect(grid).toHaveAttribute('aria-colcount', '2');
    expect(
      within(grid)
        .getAllByRole('columnheader')
        .map((h) => h.getAttribute('aria-colindex')),
    ).toEqual(['1', '2']);
    const rows = dataRows(grid);
    expect(rows[0]).toHaveAttribute('aria-rowindex', '2');
    expect(rows[4]).toHaveAttribute('aria-rowindex', '6');
    expect(
      within(rows[1]!)
        .getAllByRole('gridcell')
        .map((c) => c.getAttribute('aria-colindex')),
    ).toEqual(['1', '2']);
    expect(within(grid).getByRole('gridcell', { name: 'Item 3' })).toBeInTheDocument();
  });

  it('virtualizes 10,000 rows: only a window of DOM rows renders', () => {
    renderTable({ rows: makeItems(10_000), height: 400, rowHeight: 40, overscan: 4 });
    const grid = screen.getByRole('grid');
    expect(grid).toHaveAttribute('aria-rowcount', '10001');
    const rendered = dataRows(grid);
    expect(rendered.length).toBeLessThan(30);
    expect(rendered.length).toBeGreaterThan(5);
    expect(rendered[0]).toHaveAttribute('aria-rowindex', '2');
  });

  it('renders a new window when scrolled', () => {
    renderTable({ rows: makeItems(10_000), height: 400, rowHeight: 40, overscan: 2 });
    const grid = screen.getByRole('grid');
    fireEvent.scroll(grid, { target: { scrollTop: 40 * 5000 } });
    const rendered = dataRows(grid);
    expect(rendered.length).toBeLessThan(30);
    // The roving tab stop (row 1) stays mounted so keyboard users keep a way back into the grid.
    expect(screen.queryByText('Item 2')).not.toBeInTheDocument();
    expect(screen.getByText('Item 5001')).toBeInTheDocument();
    expect(screen.getByText('Item 5001').closest('[role="row"]')).toHaveAttribute(
      'aria-rowindex',
      '5002',
    );
  });

  it('uses density to choose the default row height', () => {
    const { container } = renderTable({ density: 'compact' });
    expect(
      container.querySelector<HTMLElement>('[role="row"][aria-rowindex="2"]')!.style.height,
    ).toBe('32px');
  });

  it('shows static skeleton rows and busy state while loading', () => {
    renderTable({ loading: true, rows: [] });
    const grid = screen.getByRole('grid');
    expect(grid).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    expect(dataRows(grid).length).toBeGreaterThan(0);
    expect(screen.queryByText('No rows to show')).not.toBeInTheDocument();
  });

  it('shows the empty state, or a custom slot', () => {
    const { rerender } = renderTable({ rows: [] });
    expect(screen.getByRole('heading', { name: 'No rows to show' })).toBeInTheDocument();
    rerender(
      <Table<Item>
        aria-label="Items"
        columns={columns}
        rows={[]}
        height={200}
        empty={<p>Nothing matches</p>}
      />,
    );
    expect(screen.getByText('Nothing matches')).toBeInTheDocument();
  });

  it('exposes aria-sort and cycles ascending, descending, none (uncontrolled)', async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    renderTable({ onSortChange });
    const header = screen.getByRole('columnheader', { name: 'Name' });
    expect(header).toHaveAttribute('aria-sort', 'none');
    expect(screen.getByRole('columnheader', { name: 'Qty' })).not.toHaveAttribute('aria-sort');
    await user.click(header);
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    expect(onSortChange).toHaveBeenLastCalledWith({ columnId: 'name', direction: 'ascending' });
    await user.click(header);
    expect(header).toHaveAttribute('aria-sort', 'descending');
    await user.click(header);
    expect(header).toHaveAttribute('aria-sort', 'none');
    expect(onSortChange).toHaveBeenLastCalledWith(null);
  });

  it('supports controlled sort and sorting from the keyboard', async () => {
    const user = userEvent.setup();
    function Controlled() {
      const [sort, setSort] = useState<TableSort | null>({
        columnId: 'name',
        direction: 'descending',
      });
      return (
        <Table<Item>
          aria-label="Items"
          columns={columns}
          rows={makeItems(3)}
          height={200}
          sort={sort}
          onSortChange={setSort}
        />
      );
    }
    renderUi(<Controlled />);
    const header = screen.getByRole('columnheader', { name: 'Name' });
    expect(header).toHaveAttribute('aria-sort', 'descending');
    header.focus();
    await user.keyboard('{Enter}');
    expect(header).toHaveAttribute('aria-sort', 'none');
    await user.keyboard(' ');
    expect(header).toHaveAttribute('aria-sort', 'ascending');
  });

  it('has a single tab stop and arrows move focus between cells and rows', async () => {
    const user = userEvent.setup();
    renderTable();
    const grid = screen.getByRole('grid');
    const stops = grid.querySelectorAll('[tabindex="0"]');
    expect(stops).toHaveLength(1);
    await user.tab();
    expect(screen.getByRole('gridcell', { name: 'Item 1' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('gridcell', { name: '1' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('gridcell', { name: '2' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('gridcell', { name: 'Item 2' })).toHaveFocus();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveFocus();
    expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it('Home/End move within a row and Ctrl+Home/End jump to the grid corners', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.tab();
    await user.keyboard('{ArrowDown}{End}');
    expect(screen.getByRole('gridcell', { name: '2' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('gridcell', { name: 'Item 2' })).toHaveFocus();
    await user.keyboard('{Control>}{End}{/Control}');
    expect(screen.getByRole('gridcell', { name: '5' })).toHaveFocus();
    await user.keyboard('{Control>}{Home}{/Control}');
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveFocus();
  });

  it('PageDown and PageUp move a page and scroll the virtual window', async () => {
    const user = userEvent.setup();
    renderTable({ rows: makeItems(10_000), height: 400, rowHeight: 40, overscan: 2 });
    await user.tab();
    await user.keyboard('{PageDown}');
    const focused = document.activeElement as HTMLElement;
    const rowIndex = Number(focused.closest('[role="row"]')!.getAttribute('aria-rowindex'));
    expect(rowIndex).toBeGreaterThan(5);
    await user.keyboard('{PageDown}{PageDown}{PageDown}');
    const later = Number(
      (document.activeElement as HTMLElement)
        .closest('[role="row"]')!
        .getAttribute('aria-rowindex'),
    );
    expect(later).toBeGreaterThan(rowIndex);
    expect(dataRows(screen.getByRole('grid')).length).toBeLessThan(30);
    await user.keyboard('{PageUp}');
    const back = Number(
      (document.activeElement as HTMLElement)
        .closest('[role="row"]')!
        .getAttribute('aria-rowindex'),
    );
    expect(back).toBeLessThan(later);
  });

  it('keeps keyboard focus on a row after it scrolls out of the window by Ctrl+End', async () => {
    const user = userEvent.setup();
    renderTable({ rows: makeItems(10_000), height: 400, rowHeight: 40 });
    await user.tab();
    await user.keyboard('{Control>}{End}{/Control}');
    expect(screen.getByRole('gridcell', { name: '10000' })).toHaveFocus();
    expect(dataRows(screen.getByRole('grid')).length).toBeLessThan(30);
  });

  it('calls onRowClick for clicks and for Enter', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    renderTable({ onRowClick });
    await user.click(screen.getByRole('gridcell', { name: 'Item 3' }));
    expect(onRowClick).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'r3' }), 2);
    await user.keyboard('{Enter}');
    expect(onRowClick).toHaveBeenCalledTimes(2);
  });

  it('does not treat clicks on interactive cell content as row clicks', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    const onInner = vi.fn();
    renderTable({
      onRowClick,
      columns: [
        { id: 'a', header: 'Action', cell: () => <button onClick={onInner}>Do it</button> },
      ],
      rows: makeItems(2),
    });
    await user.click(screen.getAllByRole('button', { name: 'Do it' })[0]!);
    expect(onInner).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('multi-select: checkbox column, aria-selected, select all with mixed state', async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    renderTable({ selectionMode: 'multiple', onSelectionChange });
    const grid = screen.getByRole('grid');
    expect(grid).toHaveAttribute('aria-multiselectable', 'true');
    expect(grid).toHaveAttribute('aria-colcount', '3');
    const rowCheckbox = screen.getByRole('checkbox', { name: 'Select row 2' });
    await user.click(rowCheckbox);
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['r2']));
    expect(rowCheckbox).toBeChecked();
    expect(rowCheckbox.closest('[role="row"]')).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getByRole('checkbox', { name: 'Select row 1' }).closest('[role="row"]'),
    ).toHaveAttribute('aria-selected', 'false');
    const all = screen.getByRole('checkbox', { name: 'Select all rows' }) as HTMLInputElement;
    expect(all.indeterminate).toBe(true);
    await user.click(all);
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['r1', 'r2', 'r3', 'r4', 'r5']));
    expect(all.checked).toBe(true);
    await user.click(all);
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set());
  });

  it('single-select replaces the selection', async () => {
    const user = userEvent.setup();
    renderTable({ selectionMode: 'single' });
    expect(screen.queryByRole('checkbox', { name: 'Select all rows' })).not.toBeInTheDocument();
    expect(screen.getByRole('grid')).not.toHaveAttribute('aria-multiselectable');
    await user.click(screen.getByRole('checkbox', { name: 'Select row 1' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select row 2' }));
    expect(screen.getByRole('checkbox', { name: 'Select row 1' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select row 2' })).toBeChecked();
  });

  it('supports controlled selection and Space to toggle from a cell', async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    renderTable({ selectionMode: 'multiple', selectedIds: new Set(['r1']), onSelectionChange });
    expect(screen.getByRole('checkbox', { name: 'Select row 1' })).toBeChecked();
    screen.getByRole('gridcell', { name: 'Item 2' }).focus();
    await user.keyboard(' ');
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['r1', 'r2']));
    // Controlled: UI follows props, not internal state.
    expect(screen.getByRole('checkbox', { name: 'Select row 2' })).not.toBeChecked();
  });

  it('arrow keys reach the selection checkbox column', async () => {
    const user = userEvent.setup();
    renderTable({ selectionMode: 'multiple' });
    await user.tab();
    expect(screen.getByRole('checkbox', { name: 'Select row 1' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('gridcell', { name: 'Item 1' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}{ArrowUp}');
    expect(screen.getByRole('checkbox', { name: 'Select all rows' })).toHaveFocus();
  });

  it('keeps selection stable when rows are windowed out of the DOM', () => {
    renderTable({
      rows: makeItems(10_000),
      height: 400,
      selectionMode: 'multiple',
      defaultSelectedIds: new Set(['r2']),
    });
    const grid = screen.getByRole('grid');
    fireEvent.scroll(grid, { target: { scrollTop: 40 * 5000 } });
    expect(screen.queryByRole('checkbox', { name: 'Select row 2' })).not.toBeInTheDocument();
    fireEvent.scroll(grid, { target: { scrollTop: 0 } });
    expect(screen.getByRole('checkbox', { name: 'Select row 2' })).toBeChecked();
  });

  it('applies column alignment', () => {
    renderTable();
    expect(screen.getByRole('gridcell', { name: '1' })).toHaveAttribute('data-align', 'end');
  });
});
