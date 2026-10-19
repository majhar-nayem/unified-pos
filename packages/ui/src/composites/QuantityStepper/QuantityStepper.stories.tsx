import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { QuantityStepper } from './QuantityStepper.js';

const meta = {
  title: 'POS/QuantityStepper',
  component: QuantityStepper,
  parameters: { surface: 'pos' },
  args: { defaultValue: 2 },
} satisfies Meta<typeof QuantityStepper>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Controlled: Story = {
  render: function ControlledStory() {
    const [qty, setQty] = useState(3);
    return (
      <QuantityStepper value={qty} onChange={setQty} max={10} label="Quantity of Oat Milk 1L" />
    );
  },
};

export const AtMinimum: Story = { args: { defaultValue: 1, min: 1 } };
export const AtMaximum: Story = { args: { defaultValue: 6, max: 6 } };
export const Weighed: Story = {
  args: {
    defaultValue: 0.842,
    step: 0.05,
    fractionDigits: 3,
    unit: 'kg',
    label: 'Weight of Bananas',
  },
};
export const ReadOnly: Story = { args: { defaultValue: 4, readOnly: true } };
export const Disabled: Story = { args: { defaultValue: 4, disabled: true } };
