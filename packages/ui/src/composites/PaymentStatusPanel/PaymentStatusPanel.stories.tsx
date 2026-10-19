import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { CardTenderLabel, PaymentStatusPanel } from './PaymentStatusPanel.js';

const meta = {
  title: 'Payments/PaymentStatusPanel',
  component: PaymentStatusPanel,
  args: { amountMinor: 3286, state: { kind: 'approved' } },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 520 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PaymentStatusPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Processing: Story = {
  args: { state: { kind: 'processing', terminalName: 'Tyro T2', registerName: 'Reg 1' } },
};
export const Approved: Story = { args: { state: { kind: 'approved' } } };
export const Declined: Story = {
  args: { state: { kind: 'declined', reason: 'Insufficient funds' } },
};
export const DeclinedLongReason: Story = {
  args: {
    state: {
      kind: 'declined',
      reason:
        'Issuer declined: the card has exceeded its contactless limit for the day and requires the customer to insert and enter a PIN, or to use a different card entirely',
    },
  },
};
export const Uncertain: Story = { args: { state: { kind: 'uncertain' }, elapsedSeconds: 18 } };
export const UncertainCallManager: Story = {
  args: { state: { kind: 'uncertain' }, elapsedSeconds: 74 },
};
export const ApprovedOffline: Story = { args: { state: { kind: 'approved-offline' } } };
export const ForwardedApproved: Story = { args: { state: { kind: 'forwarded-approved' } } };
export const DeclinedAfterReconnect: Story = {
  args: { state: { kind: 'declined-after-reconnect' } },
};
export const Expired: Story = { args: { state: { kind: 'expired' } } };
export const CapsReached: Story = {
  args: { state: { kind: 'caps-reached', count: 5, limitMinor: 50000 } },
};
export const OtherTenderLabel: Story = {
  args: {
    tenderLabel: 'Gift card',
    state: { kind: 'processing', terminalName: 'Tyro T2' },
  },
};
export const DarkTheme: Story = {
  parameters: { theme: 'dark' },
  args: { state: { kind: 'approved-offline' } },
};

export const CardButtonLabels: Story = {
  render: () => (
    <ul>
      <li>
        <CardTenderLabel />
      </li>
      <li>
        <CardTenderLabel offline />
      </li>
    </ul>
  ),
};

export const Interactive: Story = {
  render: function InteractiveStory() {
    const [kind, setKind] = useState<'processing' | 'declined'>('processing');
    return (
      <PaymentStatusPanel
        amountMinor={3286}
        state={
          kind === 'processing'
            ? { kind: 'processing', terminalName: 'Tyro T2', registerName: 'Reg 1' }
            : { kind: 'declined', reason: 'Card declined' }
        }
        onCancel={() => {
          setKind('declined');
        }}
        onRetry={() => {
          setKind('processing');
        }}
      />
    );
  },
};
