import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { UiProvider } from '../../foundation/UiProvider.js';
import { Button } from '../../primitives/Button/Button.js';

import { TenderBar, type TenderKind } from './TenderBar.js';

const meta = {
  title: 'POS/TenderBar',
  component: TenderBar,
  parameters: { surface: 'pos' },
  args: { totalDueMinor: 3286, onTender: () => {}, online: true },
} satisfies Meta<typeof TenderBar>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Online: Story = {};
export const WithCashRounding: Story = {
  args: { roundingMinor: -1, cash: { amountMinor: 3285 }, card: { amountMinor: 3286 } },
};
export const WithShortcuts: Story = {
  args: { enableShortcuts: true, other: { shortcut: 'F3' } },
};
export const WithoutOther: Story = { args: { other: false } };
export const OfflineWithinLimits: Story = {
  args: {
    online: false,
    offlineCaps: { reached: false, remainingCount: 4, remainingAmountMinor: 25000 },
  },
};
export const OfflineLimitReached: Story = {
  args: {
    online: false,
    offlineCaps: { reached: true, remainingCount: 0, remainingAmountMinor: 0 },
  },
};
export const TenderDisabledWithHint: Story = {
  args: { card: { disabled: true, hint: 'Terminal not paired' } },
};
export const WithVoidAction: Story = {
  args: {
    leading: (
      <Button variant="danger" size="lg">
        Void sale
      </Button>
    ),
  },
};
export const Interactive: Story = {
  render: function InteractiveStory(args) {
    const [last, setLast] = useState<TenderKind | null>(null);
    return (
      <div>
        <TenderBar {...args} enableShortcuts onTender={setLast} />
        <p role="status">{last ? `Chose ${last}` : 'Press F1 or F2'}</p>
      </div>
    );
  },
};
export const LargeText: Story = {
  render: (args) => (
    <UiProvider textScale="large">
      <TenderBar
        {...args}
        online={false}
        offlineCaps={{ reached: false, remainingCount: 2, remainingAmountMinor: 10000 }}
      />
    </UiProvider>
  ),
};
