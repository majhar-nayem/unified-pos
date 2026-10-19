import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';

import { Button } from '../Button/Button.js';

import { Tooltip } from './Tooltip.js';

const frame: Decorator = (Story) => (
  <div style={{ padding: '64px 160px' }}>
    <Story />
  </div>
);

const meta = {
  title: 'Primitives/Tooltip',
  component: Tooltip,
  args: {
    content: 'Reprint the last receipt',
    children: <Button variant="secondary">Reprint</Button>,
  },
  decorators: [frame],
} satisfies Meta<typeof Tooltip>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Closed until hovered or focused. Hover or tab to the button. */
export const Default: Story = {};
export const OpenTop: Story = { args: { defaultOpen: true } };
export const OpenBottom: Story = { args: { defaultOpen: true, placement: 'bottom' } };
export const LongContent: Story = {
  args: {
    defaultOpen: true,
    content:
      'Voiding a sent item notifies the kitchen immediately and requires a manager approval with a reason.',
  },
};
export const OnInput: Story = {
  args: {
    defaultOpen: true,
    placement: 'bottom',
    content: 'Scan or type the barcode',
    children: <input aria-label="Barcode" defaultValue="9300633123456" />,
  },
};
