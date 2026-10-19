import type { Meta, StoryObj } from '@storybook/react-vite';

import { Badge, StatusPill } from './StatusPill.js';

const meta = {
  title: 'Primitives/StatusPill',
  component: StatusPill,
  args: { label: 'Synced' },
} satisfies Meta<typeof StatusPill>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Success: Story = { args: { tone: 'success', label: 'Captured' } };
export const Warning: Story = { args: { tone: 'warning', label: 'Approved offline' } };
export const Danger: Story = { args: { tone: 'danger', label: 'Declined' } };
export const Info: Story = { args: { tone: 'info', label: 'Processing', icon: 'processing' } };
export const Offline: Story = { args: { tone: 'offline', label: 'Offline' } };
export const Brand: Story = { args: { tone: 'brand', label: 'New' } };
export const Small: Story = { args: { tone: 'success', label: 'Paid', size: 'sm' } };
export const TableStatuses: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <StatusPill palette="table-available" icon="check-circle" label="Available" />
      <StatusPill palette="table-occupied" icon="utensils" label="Occupied" />
      <StatusPill palette="table-reserved" icon="clock" label="Reserved" />
      <StatusPill palette="table-dirty" icon="alert" label="Dirty" />
      <StatusPill palette="table-blocked" icon="ban" label="Blocked" />
    </div>
  ),
};
export const KdsAgeStatuses: Story = {
  parameters: { surface: 'kds' },
  render: () => (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <StatusPill palette="kds-age-fresh" icon="check" label="Fresh" />
      <StatusPill palette="kds-age-aging" icon="clock" label="Aging" />
      <StatusPill palette="kds-age-late" icon="alert" label="Late" />
      <StatusPill palette="kds-age-critical" icon="flag" label="Critical" />
    </div>
  ),
};
export const PaymentStatuses: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <StatusPill palette="payment-processing" icon="processing" label="Processing" />
      <StatusPill palette="payment-authorized" icon="check" label="Authorised" />
      <StatusPill palette="payment-captured" icon="check-circle" label="Captured" />
      <StatusPill palette="payment-uncertain" icon="alert" label="Uncertain" />
      <StatusPill palette="payment-failed" icon="x-circle" label="Declined" />
      <StatusPill palette="payment-offline-approved" icon="wifi-off" label="Approved offline" />
      <StatusPill palette="payment-expired" icon="hourglass" label="Expired" />
      <StatusPill palette="payment-caps-reached" icon="ban" label="Limit reached" />
    </div>
  ),
};
export const CountBadge: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8 }}>
      <Badge count={3} label="3 unsynced sales" />
      <Badge count={250} label="More than 99 unsynced sales" tone="warning" />
    </div>
  ),
};
