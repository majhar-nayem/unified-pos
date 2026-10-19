import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Toggle, type ToggleProps } from './Toggle.js';

function InteractiveToggle(props: ToggleProps) {
  const [checked, setChecked] = useState(true);
  return <Toggle {...props} checked={checked} onCheckedChange={setChecked} />;
}

const meta = {
  title: 'Primitives/Toggle',
  component: Toggle,
  args: { label: 'Print receipt automatically' },
} satisfies Meta<typeof Toggle>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Off: Story = {};
export const On: Story = { args: { defaultChecked: true } };
export const DisabledOff: Story = { args: { disabled: true } };
export const DisabledOn: Story = { args: { disabled: true, defaultChecked: true } };
export const AriaLabelOnly: Story = { args: { label: undefined, 'aria-label': 'Sound alerts' } };
export const LongLabel: Story = {
  args: {
    label:
      'Send the customer a digital receipt by email whenever a phone number or address is on file',
  },
};
export const Interactive: Story = {
  render: (args) => <InteractiveToggle {...args} />,
};
