import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { UiProvider } from '../../foundation/UiProvider.js';
import { Button } from '../../primitives/Button/Button.js';

import { CartSummary } from './CartSummary.js';

const meta = {
  title: 'POS/CartSummary',
  component: CartSummary,
  parameters: { surface: 'pos' },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 420 }}>
        <Story />
      </div>
    ),
  ],
  args: {
    itemCount: 4,
    subtotalMinor: 3386,
    discountMinor: 100,
    taxMinor: 299,
    tax: 'inclusive',
    totalMinor: 3286,
  },
} satisfies Meta<typeof CartSummary>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const TaxExclusive: Story = { args: { tax: 'exclusive', taxMinor: 329, totalMinor: 3615 } };
export const WithTipAndService: Story = {
  args: {
    tax: 'exclusive',
    taxMinor: 329,
    serviceChargeMinor: 339,
    tipMinor: 500,
    totalMinor: 4454,
  },
};
export const WithCashRounding: Story = { args: { roundingMinor: -1, totalMinor: 3285 } };
export const PartPaid: Story = {
  args: { paidMinor: 2000, amountDueMinor: 1286 },
};
export const CashTenderedWithChange: Story = {
  args: { paidMinor: 5000, amountDueMinor: 0, changeMinor: 1714 },
};
export const EmptyCart: Story = {
  args: { itemCount: 0, subtotalMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 0 },
};
export const LiveTotalAnnouncement: Story = {
  render: function LiveStory() {
    const [qty, setQty] = useState(1);
    return (
      <div>
        <CartSummary
          itemCount={qty}
          subtotalMinor={qty * 450}
          taxMinor={Math.round((qty * 450) / 11)}
          totalMinor={qty * 450}
        />
        <Button variant="secondary" onClick={() => setQty((q) => q + 1)}>
          Add another
        </Button>
      </div>
    );
  },
};
export const LargeText: Story = {
  render: (args) => (
    <UiProvider textScale="large">
      <div style={{ maxWidth: 420 }}>
        <CartSummary {...args} />
      </div>
    </UiProvider>
  ),
};
