import type { Meta, StoryObj } from '@storybook/react-vite';

import { UiProvider } from '../../foundation/UiProvider.js';

import { SyncQueueBadge } from './SyncQueueBadge.js';

const meta = {
  title: 'POS/SyncQueueBadge',
  component: SyncQueueBadge,
  parameters: { surface: 'pos' },
  args: { pendingCount: 0 },
} satisfies Meta<typeof SyncQueueBadge>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AllSynced: Story = {};
export const HiddenWhenSynced: Story = { args: { hideWhenSynced: true } };
export const Pending: Story = { args: { pendingCount: 3 } };
export const PendingSingle: Story = { args: { pendingCount: 1 } };
export const PendingWithOldest: Story = { args: { pendingCount: 12, oldestAgeSeconds: 725 } };
export const ManyPending: Story = { args: { pendingCount: 250 } };
export const Stuck: Story = { args: { pendingCount: 2, error: { rejectedCount: 2 } } };
export const RejectedOnly: Story = { args: { pendingCount: 0, error: { rejectedCount: 1 } } };
export const OfflinePaymentsPlentyOfTime: Story = {
  args: {
    online: false,
    pendingCount: 2,
    offlinePayments: { count: 2, soonestExpirySeconds: 5 * 3600 + 120 },
  },
};
export const OfflinePaymentsAmber: Story = {
  args: {
    online: false,
    pendingCount: 1,
    offlinePayments: { count: 1, soonestExpirySeconds: 2700 },
  },
};
export const OfflinePaymentsExpired: Story = {
  args: { online: false, pendingCount: 1, offlinePayments: { count: 1, soonestExpirySeconds: 0 } },
};
export const OfflinePaymentsBeingSubmitted: Story = {
  args: {
    online: true,
    pendingCount: 2,
    offlinePayments: { count: 2, soonestExpirySeconds: 2700 },
  },
};
export const LargeText: Story = {
  args: {
    online: false,
    pendingCount: 12,
    oldestAgeSeconds: 725,
    error: { rejectedCount: 1 },
    offlinePayments: { count: 2, soonestExpirySeconds: 2700 },
  },
  render: (args) => (
    <UiProvider textScale="large">
      <div style={{ maxWidth: 360 }}>
        <SyncQueueBadge {...args} />
      </div>
    </UiProvider>
  ),
};
