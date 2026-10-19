import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Radio, RadioGroup, type RadioGroupProps } from './Radio.js';

function InteractiveGroup(props: RadioGroupProps) {
  const [value, setValue] = useState('print');
  return (
    <RadioGroup {...props} value={value} onValueChange={setValue}>
      <Radio value="print" label="Print" />
      <Radio value="email" label="Email" />
      <Radio value="none" label="No receipt" />
    </RadioGroup>
  );
}

const meta = {
  title: 'Primitives/Radio',
  component: RadioGroup,
  args: { label: 'Receipt', children: null },
  render: (args) => (
    <RadioGroup {...args}>
      <Radio value="print" label="Print" />
      <Radio value="email" label="Email" hint="Needs an email on the customer record." />
      <Radio value="none" label="No receipt" />
    </RadioGroup>
  ),
} satisfies Meta<typeof RadioGroup>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Selected: Story = { args: { defaultValue: 'email' } };
export const Horizontal: Story = { args: { orientation: 'horizontal', defaultValue: 'print' } };
export const WithHint: Story = { args: { hint: 'Applies to this sale only.' } };
export const Required: Story = { args: { required: true } };
export const Invalid: Story = {
  args: { error: 'Choose how to send the receipt.', required: true },
};
export const Disabled: Story = { args: { disabled: true, defaultValue: 'print' } };
export const OptionDisabled: Story = {
  render: (args) => (
    <RadioGroup {...args}>
      <Radio value="print" label="Print" />
      <Radio value="email" label="Email" disabled />
    </RadioGroup>
  ),
};
export const Interactive: Story = {
  render: (args) => <InteractiveGroup {...args} />,
};
