import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';

import { Button } from '../Button/Button.js';
import { StatusPill } from '../StatusPill/StatusPill.js';

import { Table, type TableColumn, type TableSort } from './Table.js';

interface Order {
  readonly id: number;
  readonly customer: string;
  readonly channel: 'Dine-in' | 'Takeaway' | 'Delivery';
  readonly total: number;
  readonly paid: boolean;
}

const channels = ['Dine-in', 'Takeaway', 'Delivery'] as const;
const names = ['Marco', 'Lena', 'Sam', 'Priya', 'Chen', 'Ava', 'Noah', 'Mia'];

function makeOrders(count: number): Order[] {
  return Array.from({ length: count }, (_, i) => ({
    id: 1000 + i,
    customer: `${names[i % names.length] ?? 'Guest'} ${i + 1}`,
    channel: channels[i % channels.length] ?? 'Dine-in',
    total: 1250 + ((i * 337) % 9000),
    paid: i % 3 !== 0,
  }));
}

const columns: TableColumn<Order>[] = [
  { id: 'id', header: 'Order', cell: (row) => `#${row.id}`, width: 100, sortable: true },
  { id: 'customer', header: 'Customer', cell: (row) => row.customer, sortable: true },
  { id: 'channel', header: 'Channel', cell: (row) => row.channel, width: 140 },
  {
    id: 'total',
    header: 'Total',
    align: 'end',
    width: 120,
    sortable: true,
    cell: (row) => <span className="pos-num">{(row.total / 100).toFixed(2)}</span>,
  },
  {
    id: 'status',
    header: 'Status',
    width: 140,
    cell: (row) =>
      row.paid ? (
        <StatusPill tone="success" size="sm" label="Paid" />
      ) : (
        <StatusPill tone="warning" size="sm" label="Open" />
      ),
  },
];

const small = makeOrders(12);

const meta = {
  title: 'Primitives/Table',
  component: Table<Order>,
  args: {
    columns,
    rows: small,
    height: 360,
    'aria-label': 'Orders',
    getRowId: (row: Order) => String(row.id),
  },
  parameters: { surface: 'admin' },
} satisfies Meta<typeof Table<Order>>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Compact: Story = { args: { density: 'compact' } };
export const Loading: Story = { args: { loading: true } };
export const Empty: Story = { args: { rows: [] } };
export const EmptyCustomSlot: Story = {
  args: {
    rows: [],
    empty: (
      <div style={{ padding: 32, textAlign: 'center' }}>
        <p>No orders match these filters.</p>
        <Button variant="secondary">Clear filters</Button>
      </div>
    ),
  },
};
export const Sorted: Story = {
  args: { defaultSort: { columnId: 'total', direction: 'descending' } },
};
export const SingleSelection: Story = {
  args: { selectionMode: 'single', defaultSelectedIds: new Set(['1002']) },
};
export const MultiSelection: Story = {
  args: { selectionMode: 'multiple', defaultSelectedIds: new Set(['1001', '1003']) },
};
export const RowClick: Story = { args: { onRowClick: () => undefined } };
export const LongContent: Story = {
  args: {
    rows: small.map((row) => ({
      ...row,
      customer: `${row.customer} with an exceptionally long customer name that truncates`,
    })),
  },
};

function TenThousandRows() {
  const rows = useMemo(() => makeOrders(10_000), []);
  const [sort, setSort] = useState<TableSort | null>(null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const key = sort.columnId as keyof Order;
    const factor = sort.direction === 'ascending' ? 1 : -1;
    return [...rows].sort((a, b) => (a[key] > b[key] ? factor : a[key] < b[key] ? -factor : 0));
  }, [rows, sort]);
  return (
    <>
      <p>10,000 rows; only the visible window exists in the DOM.</p>
      <Table
        aria-label="All orders"
        columns={columns}
        rows={sorted}
        height={420}
        getRowId={(row) => String(row.id)}
        sort={sort}
        onSortChange={setSort}
        selectionMode="multiple"
      />
    </>
  );
}
export const TenThousandRowsVirtualized: Story = { render: () => <TenThousandRows /> };
