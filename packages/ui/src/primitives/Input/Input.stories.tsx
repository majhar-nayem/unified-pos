import type { Meta, StoryObj } from '@storybook/react-vite';

import { Input } from './Input.js';

const meta = {
  title: 'Primitives/Input',
  component: Input,
  args: { label: 'Customer name' },
} satisfies Meta<typeof Input>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { placeholder: 'Jane Citizen' } };
export const Small: Story = { args: { size: 'sm' } };
export const Large: Story = { args: { size: 'lg' } };
export const WithHint: Story = { args: { hint: 'As it should appear on the receipt.' } };
export const Required: Story = { args: { required: true } };
export const Optional: Story = { args: { optional: true } };
export const Invalid: Story = { args: { error: 'Enter the customer name.', defaultValue: '' } };
export const Disabled: Story = { args: { disabled: true, defaultValue: 'Locked value' } };
export const ReadOnly: Story = { args: { readOnly: true, defaultValue: 'Read-only value' } };
export const Telephone: Story = {
  args: { type: 'tel', label: 'Mobile', placeholder: '04xx xxx xxx' },
};
export const Email: Story = {
  args: { type: 'email', label: 'Email', placeholder: 'name@example.com' },
};
export const Password: Story = {
  args: { type: 'password', label: 'Password', defaultValue: 'secret' },
};
export const NumberType: Story = {
  args: { type: 'number', label: 'Quantity', defaultValue: '2', inputMode: 'numeric' },
};
export const PrefixAndSuffix: Story = {
  args: {
    label: 'Discount',
    prefix: '$',
    suffix: 'AUD',
    defaultValue: '5.00',
    inputMode: 'decimal',
  },
};
export const HiddenLabel: Story = { args: { hideLabel: true } };
export const AdminSurface: Story = { parameters: { surface: 'admin' } };
