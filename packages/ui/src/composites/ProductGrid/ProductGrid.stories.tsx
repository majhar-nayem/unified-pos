import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { UiProvider } from '../../foundation/UiProvider.js';

import { ProductGrid, type ProductGridItem } from './ProductGrid.js';

const names = [
  'Sourdough Loaf',
  'Bagels 6pk',
  'Croissant',
  'Bananas',
  'Flat White',
  'Oat Milk 1L',
  'Coffee Beans 250g',
  'Shiraz 750ml',
  'Free-range Eggs 12pk',
  'Butter 250g',
  'Cheddar 500g',
  'Sparkling Water',
  'Muesli Bar',
  'Apple',
];

const products: ProductGridItem[] = names.map((name, index) => ({
  id: `p${index}`,
  name,
  priceMinor: 300 + index * 125,
  ...(name === 'Bananas' ? { priceSuffix: '/kg' } : {}),
  ...(name === 'Shiraz 750ml' ? { ageRestricted: true } : {}),
  ...(index === 2 ? { stock: 'low' as const, stockCount: 3 } : {}),
  ...(index === 5 ? { stock: 'out' as const } : {}),
  ...(index === 9 ? { unavailable: true } : {}),
}));

const meta = {
  title: 'POS/ProductGrid',
  component: ProductGrid,
  parameters: { surface: 'pos' },
  args: { products, pageSize: 8 },
} satisfies Meta<typeof ProductGrid>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const SinglePage: Story = { args: { pageSize: undefined, products: products.slice(0, 6) } };
export const FixedColumns: Story = { args: { columns: 3, pageSize: 6 } };
export const SecondPage: Story = { args: { defaultPage: 2 } };
export const Empty: Story = { args: { products: [] } };
export const Selectable: Story = {
  render: function SelectableStory(args) {
    const [selectedId, setSelectedId] = useState<string | null>('p1');
    return <ProductGrid {...args} selectedId={selectedId} onSelect={setSelectedId} />;
  },
};
export const LargeText: Story = {
  render: (args) => (
    <UiProvider textScale="large">
      <ProductGrid {...args} columns={4} pageSize={8} />
    </UiProvider>
  ),
};
