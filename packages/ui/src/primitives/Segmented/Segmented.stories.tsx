import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Segmented, type SegmentedProps } from './Segmented.js';

function InteractiveSegmented(props: SegmentedProps) {
  const [value, setValue] = useState('card');
  return <Segmented {...props} value={value} onValueChange={setValue} />;
}

const tender = [
  { value: 'cash', label: 'Cash', icon: 'cash' as const },
  { value: 'card', label: 'Card', icon: 'card' as const },
];

const meta = {
  title: 'Primitives/Segmented',
  component: Segmented,
  args: { label: 'Tender', options: tender, defaultValue: 'cash' },
} satisfies Meta<typeof Segmented>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Tender: Story = {};
export const Quantity: Story = {
  args: {
    label: 'Quantity step',
    options: [
      { value: '1', label: '1' },
      { value: '5', label: '5' },
      { value: '10', label: '10' },
      { value: '25', label: '25' },
      { value: '100', label: '100' },
    ],
    defaultValue: '5',
  },
};
export const Large: Story = { args: { size: 'lg' } };
export const FullWidth: Story = { args: { fullWidth: true } };
export const OptionDisabled: Story = {
  args: { options: [...tender, { value: 'gift', label: 'Gift card', disabled: true }] },
};
export const Disabled: Story = { args: { disabled: true } };
export const Interactive: Story = {
  render: (args) => <InteractiveSegmented {...args} />,
};
