import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { UiProvider } from '../../foundation/UiProvider.js';

import { ProductTile } from './ProductTile.js';

const meta = {
  title: 'POS/ProductTile',
  component: ProductTile,
  parameters: { surface: 'pos' },
  decorators: [
    (Story) => (
      <div style={{ width: 128 }}>
        <Story />
      </div>
    ),
  ],
  args: { productId: 'sourdough', name: 'Sourdough Loaf', priceMinor: 800 },
} satisfies Meta<typeof ProductTile>;
export default meta;
type Story = StoryObj<typeof meta>;

// A tiny inline SVG so stories never hit the network.
const sampleImage =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='96' height='48'><rect width='96' height='48' fill='%23cbd5e1'/></svg>";

export const Default: Story = {};
export const Selected: Story = { args: { selected: true } };
export const WithImage: Story = {
  args: { imageSrc: sampleImage, imageAlt: 'A round sourdough loaf' },
};
export const InitialsFallback: Story = { args: { name: 'Coffee Beans 250g', priceMinor: 1400 } };
export const LowStock: Story = { args: { stock: 'low', stockCount: 3 } };
export const OutOfStock: Story = { args: { stock: 'out' } };
export const OutOfStockSellable: Story = { args: { stock: 'out', allowOutOfStock: true } };
export const Unavailable86d: Story = { args: { unavailable: true } };
export const AgeRestricted: Story = {
  args: { productId: 'wine', name: 'Shiraz 750ml', priceMinor: 2495, ageRestricted: true },
};
export const WithBadge: Story = { args: { badge: 'Promo' } };
export const Weighed: Story = {
  args: { productId: 'banana', name: 'Bananas', priceMinor: 399, priceSuffix: '/kg' },
};
export const LongName: Story = {
  args: {
    name: 'Organic Cold-Pressed Extra Virgin Olive Oil with Hand-Picked Kalamata Olives 750ml',
    priceMinor: 3286,
  },
};
export const Interactive: Story = {
  render: function InteractiveStory(args) {
    const [selected, setSelected] = useState(false);
    return <ProductTile {...args} selected={selected} onSelect={() => setSelected((s) => !s)} />;
  },
};
export const LargeText: Story = {
  args: { stock: 'low', stockCount: 3, ageRestricted: true },
  render: (args) => (
    <UiProvider textScale="large">
      <div style={{ width: 160 }}>
        <ProductTile {...args} />
      </div>
    </UiProvider>
  ),
};
