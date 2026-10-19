import type { Meta, StoryObj } from '@storybook/react-vite';

import { UiProvider } from '../../foundation/UiProvider.js';

import { ConnectivityIndicator } from './ConnectivityIndicator.js';

const meta = {
  title: 'POS/ConnectivityIndicator',
  component: ConnectivityIndicator,
  parameters: { surface: 'pos' },
  args: { status: 'online' },
} satisfies Meta<typeof ConnectivityIndicator>;
export default meta;
type Story = StoryObj<typeof meta>;

const lastSync = new Date(2026, 9, 18, 12, 41).getTime();

export const Online: Story = {};
export const Offline: Story = { args: { status: 'offline' } };
export const Degraded: Story = { args: { status: 'degraded' } };
export const Syncing: Story = { args: { status: 'syncing' } };
export const CompactOnline: Story = { args: { compact: true } };
export const CompactOffline: Story = { args: { compact: true, status: 'offline' } };
export const CompactDegraded: Story = { args: { compact: true, status: 'degraded' } };
export const CompactSyncing: Story = { args: { compact: true, status: 'syncing' } };
export const FullWithLastSync: Story = { args: { status: 'offline', lastSyncAt: lastSync } };
export const KdsSurface: Story = {
  args: { status: 'offline', compact: true },
  parameters: { surface: 'kds' },
};
export const LargeText: Story = {
  args: { status: 'offline', lastSyncAt: lastSync },
  render: (args) => (
    <UiProvider textScale="large">
      <ConnectivityIndicator {...args} />
    </UiProvider>
  ),
};
