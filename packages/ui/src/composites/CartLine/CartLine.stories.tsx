import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';

import { UiProvider } from '../../foundation/UiProvider.js';
import { Button } from '../../primitives/Button/Button.js';

import { CartLine, CartLineList } from './CartLine.js';

const meta = {
  title: 'POS/CartLine',
  component: CartLine,
  parameters: { surface: 'pos' },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 420 }}>
        <Story />
      </div>
    ),
  ],
  args: {
    name: 'Oat Milk 1L',
    quantity: 2,
    unitPriceMinor: 450,
    lineTotalMinor: 900,
  },
} satisfies Meta<typeof CartLine>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Selected: Story = { args: { state: 'selected' } };
export const WithDiscount: Story = {
  args: {
    lineTotalMinor: 800,
    discounts: [{ label: 'PROMO 2-for-8', amountMinor: 100 }],
  },
};
export const WithModifiers: Story = {
  args: {
    name: 'Flat White',
    quantity: 1,
    unitPriceMinor: 480,
    lineTotalMinor: 580,
    details: ['Large', 'Oat milk (+$0.50)', 'Extra shot (+$0.50)'],
  },
};
export const Weighed: Story = {
  args: {
    name: 'Bananas',
    quantity: 0.842,
    quantityFractionDigits: 3,
    unitLabel: 'kg',
    unitPriceMinor: 399,
    lineTotalMinor: 336,
  },
};
export const Voided: Story = { args: { state: 'voided' } };
export const Unsent: Story = { args: { state: 'unsent' } };
export const Sent: Story = { args: { state: 'sent' } };
export const PendingApproval: Story = {
  args: {
    state: 'pending-approval',
    discounts: [{ label: 'Manager discount 20%', amountMinor: 180 }],
    lineTotalMinor: 720,
  },
};
export const TaxInclusive: Story = { args: { taxInclusive: true } };
export const LongName: Story = {
  args: {
    name: 'Organic Cold-Pressed Extra Virgin Olive Oil with Hand-Picked Kalamata Olives 750ml Gift Pack',
    quantity: 1,
    unitPriceMinor: 3286,
    lineTotalMinor: 3286,
  },
};

export const SelectableWithControls: Story = {
  render: function SelectableStory() {
    const [qty, setQty] = useState(2);
    const [selected, setSelected] = useState(true);
    return (
      <CartLine
        name="Oat Milk 1L"
        quantity={qty}
        unitPriceMinor={450}
        lineTotalMinor={qty * 450}
        selected={selected}
        onSelect={() => setSelected((s) => !s)}
        onQuantityChange={setQty}
        actions={
          <Button variant="danger" size="sm">
            Void
          </Button>
        }
      />
    );
  },
};

const sampleLines = [
  {
    id: 'milk',
    name: 'Oat Milk 1L',
    qty: 2,
    unit: 450,
    total: 800,
    discounts: [{ label: 'PROMO 2-for-8', amountMinor: 100 }],
  },
  { id: 'bread', name: 'Sourdough Loaf', qty: 1, unit: 800, total: 800 },
  { id: 'beans', name: 'Coffee Beans 250g', qty: 1, unit: 1400, total: 1400 },
];

function ListStory({ children }: { children?: ReactNode }) {
  const [selectedId, setSelectedId] = useState<string | null>('bread');
  return (
    <CartLineList
      selectedId={selectedId}
      onSelectedIdChange={setSelectedId}
      selectedActions={
        <>
          <Button variant="secondary">Qty</Button>
          <Button variant="secondary">Discount</Button>
          <Button variant="danger">Void</Button>
        </>
      }
    >
      {sampleLines.map((line) => (
        <CartLine
          key={line.id}
          lineId={line.id}
          name={line.name}
          quantity={line.qty}
          unitPriceMinor={line.unit}
          lineTotalMinor={line.total}
          {...(line.discounts ? { discounts: line.discounts } : {})}
        />
      ))}
      {children}
    </CartLineList>
  );
}

export const ListWithRovingFocus: Story = {
  render: () => (
    <div style={{ maxWidth: 420 }}>
      <ListStory />
    </div>
  ),
};

export const ListEmpty: Story = {
  render: () => (
    <div style={{ maxWidth: 420 }}>
      <CartLineList />
    </div>
  ),
};

export const LargeText: Story = {
  render: () => (
    <UiProvider textScale="large">
      <div style={{ maxWidth: 420 }}>
        <ListStory />
      </div>
    </UiProvider>
  ),
};
