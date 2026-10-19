import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Stepper, type StepperProps, type StepperStep } from './Stepper.js';

function ClickableStepper(props: StepperProps) {
  const [current, setCurrent] = useState(2);
  return <Stepper {...props} current={current} onStepClick={(index) => setCurrent(index)} />;
}

const steps: StepperStep[] = [
  { id: 'upload', label: 'Upload file', description: 'CSV or XLSX' },
  { id: 'map', label: 'Map columns' },
  { id: 'review', label: 'Review changes' },
  { id: 'import', label: 'Import' },
];

const meta = {
  title: 'Primitives/Stepper',
  component: Stepper,
  args: { steps, current: 1 },
} satisfies Meta<typeof Stepper>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const FirstStep: Story = { args: { current: 0 } };
export const LastStep: Story = { args: { current: 3 } };
export const AllComplete: Story = { args: { current: 4 } };
export const WithError: Story = {
  args: {
    steps: steps.map((s, i) =>
      i === 1 ? { ...s, state: 'error' as const, description: '2 columns unmapped' } : s,
    ),
  },
};
export const Vertical: Story = { args: { orientation: 'vertical' } };
export const AdminSurface: Story = { parameters: { surface: 'admin' } };
export const LongLabels: Story = {
  args: {
    steps: steps.map((s) => ({
      ...s,
      label: `${String(s.label)} with a considerably longer label than usual`,
    })),
  },
};
export const Clickable: Story = {
  render: (args) => <ClickableStepper {...args} />,
};
