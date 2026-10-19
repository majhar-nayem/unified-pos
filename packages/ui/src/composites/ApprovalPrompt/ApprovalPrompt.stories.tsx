import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { ApprovalPrompt } from './ApprovalPrompt.js';

const meta: Meta<typeof ApprovalPrompt> = {
  title: 'POS/ApprovalPrompt',
  component: ApprovalPrompt,
  args: {
    open: true,
    action: 'Void sent item: Burger Lg',
    reason: 'Customer changed their mind',
    requestedBy: 'Sam (Server)',
    onApprovePin: fn(),
    onApprovePasskey: fn(),
    onCancel: fn(),
  },
};
export default meta;
type Story = StoryObj<typeof meta>;

export const PinEntry: Story = {};
export const OverLimitDiscount: Story = {
  args: { action: 'Discount 25%', limit: 'Over your 10% limit', reason: undefined },
};
export const PinOrPasskey: Story = { args: { methods: ['pin', 'passkey'] } };
export const PasskeyOnly: Story = { args: { methods: ['passkey'] } };
export const Verifying: Story = { args: { status: 'verifying' } };
export const Denied: Story = { args: { status: 'denied' } };
export const VerificationError: Story = { args: { status: 'error' } };
