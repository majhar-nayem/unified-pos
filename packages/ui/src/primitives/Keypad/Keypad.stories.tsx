import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Keypad, type KeypadProps } from './Keypad.js';

function Controlled(props: KeypadProps) {
  const [value, setValue] = useState(props.defaultValue ?? '');
  return <Keypad {...props} value={value} onChange={setValue} />;
}

const meta = {
  title: 'Primitives/Keypad',
  component: Keypad,
  render: (args) => <Controlled {...args} />,
} satisfies Meta<typeof Keypad>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Quantity: Story = { args: { mode: 'digits', label: 'Quantity', maxLength: 4 } };
export const Decimal: Story = {
  args: { mode: 'digits', decimal: true, label: 'Weight', defaultValue: '1.25' },
};
export const Pin: Story = {
  args: { mode: 'pin', label: 'Manager PIN', defaultValue: '12', actionLabel: 'Enter' },
};
export const PinEmpty: Story = { args: { mode: 'pin', label: 'Manager PIN' } };
export const CashAmount: Story = {
  args: { mode: 'amount', label: 'Cash received', defaultValue: '2050', actionLabel: 'Done' },
};
export const CashAmountEmpty: Story = { args: { mode: 'amount', label: 'Cash received' } };
export const WithAction: Story = {
  args: { actionLabel: 'Enter', label: 'Quantity', defaultValue: '3' },
};
export const ActionDisabled: Story = {
  args: { actionLabel: 'Enter', actionDisabled: true, label: 'Quantity' },
};
export const NoClear: Story = { args: { showClear: false, label: 'Quantity', defaultValue: '7' } };
export const HiddenDisplay: Story = { args: { hideDisplay: true, label: 'Quantity' } };
export const Disabled: Story = { args: { disabled: true, label: 'Quantity', defaultValue: '12' } };
export const KdsSurface: Story = { args: { label: 'Quantity' }, parameters: { surface: 'kds' } };
