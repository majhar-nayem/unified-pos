import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Button } from '../Button/Button.js';

import { Banner } from './Banner.js';

const meta = {
  title: 'Primitives/Banner',
  component: Banner,
  args: { tone: 'info', children: 'Prices updated at 14:00.' },
} satisfies Meta<typeof Banner>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Info: Story = {};
export const Success: Story = { args: { tone: 'success', children: 'All sales synced.' } };
export const Warning: Story = { args: { tone: 'warning', children: 'Printer 2 is low on paper.' } };
export const Danger: Story = {
  args: { tone: 'danger', children: 'The card terminal is disconnected.' },
};
export const OfflineTone: Story = { args: { tone: 'offline', children: 'Working offline.' } };
export const VariantOffline: Story = {
  args: { tone: undefined, variant: 'offline', children: undefined },
};
export const VariantDegraded: Story = {
  args: { tone: undefined, variant: 'degraded', station: 'Grill', children: undefined },
};
export const VariantCloudRouting: Story = {
  args: { tone: undefined, variant: 'cloudRouting', children: undefined },
};
export const VariantWarning: Story = {
  args: { tone: undefined, variant: 'warning', children: undefined },
};
export const WithAction: Story = {
  args: {
    tone: undefined,
    variant: 'offline',
    children: undefined,
    action: (
      <Button size="sm" variant="secondary">
        View queue
      </Button>
    ),
  },
};
export const WithActionAndDismiss: Story = {
  args: {
    tone: 'warning',
    children: '3 sales are waiting to sync.',
    action: (
      <Button size="sm" variant="secondary">
        Sync now
      </Button>
    ),
    onDismiss: () => undefined,
  },
};
export const LongContent: Story = {
  args: {
    tone: 'warning',
    children:
      'KDS hub degraded — printing fallback is active at every station in this location until the hub reconnects and the queued tickets are replayed in order.',
    onDismiss: () => undefined,
  },
};
export const KdsSurface: Story = {
  args: { tone: undefined, variant: 'degraded', station: 'Grill', children: undefined },
  parameters: { surface: 'kds' },
};

function DismissibleDemo() {
  const [visible, setVisible] = useState(true);
  return visible ? (
    <Banner tone="info" onDismiss={() => setVisible(false)}>
      Dismiss me.
    </Banner>
  ) : (
    <p>Dismissed.</p>
  );
}
export const Dismissible: Story = { render: () => <DismissibleDemo /> };
