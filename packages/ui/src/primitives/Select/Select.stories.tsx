import type { Meta, StoryObj } from '@storybook/react-vite';

import { Select } from './Select.js';

const options = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'voucher', label: 'Voucher' },
];

const meta = {
  title: 'Primitives/Select',
  component: Select,
  args: { label: 'Payment method', options, defaultValue: 'card' },
} satisfies Meta<typeof Select>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Small: Story = { args: { size: 'sm' } };
export const Large: Story = { args: { size: 'lg' } };
export const WithPlaceholder: Story = {
  args: { placeholder: 'Choose a method', defaultValue: undefined },
};
export const WithHint: Story = { args: { hint: 'Used when no tender is picked at the till.' } };
export const Required: Story = { args: { required: true } };
export const Optional: Story = { args: { optional: true } };
export const Invalid: Story = {
  args: {
    error: 'Choose a payment method.',
    placeholder: 'Choose a method',
    defaultValue: undefined,
  },
};
export const Disabled: Story = { args: { disabled: true } };
export const OptionDisabled: Story = {
  args: { options: [...options, { value: 'gift', label: 'Gift card', disabled: true }] },
};
export const AdminSurface: Story = { parameters: { surface: 'admin' } };
