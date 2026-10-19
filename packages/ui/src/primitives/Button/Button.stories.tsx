import type { Meta, StoryObj } from '@storybook/react-vite';

import { Icon } from '../../foundation/Icon.js';

import { Button } from './Button.js';

const meta = {
  title: 'Primitives/Button',
  component: Button,
  args: { children: 'Pay now' },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {};
export const Secondary: Story = { args: { variant: 'secondary', children: 'Hold order' } };
export const Danger: Story = { args: { variant: 'danger', children: 'Void line' } };
export const Ghost: Story = { args: { variant: 'ghost', children: 'Cancel' } };
export const Small: Story = { args: { size: 'sm' } };
export const Large: Story = { args: { size: 'lg' } };
export const Tender: Story = { args: { size: 'tender', children: 'Cash' } };
export const WithIcons: Story = {
  args: {
    iconStart: <Icon name="card" />,
    iconEnd: <Icon name="chevron-right" />,
    children: 'Card',
  },
};
export const Disabled: Story = { args: { disabled: true } };
export const Loading: Story = { args: { loading: true, children: 'Saving' } };
export const FullWidth: Story = { args: { fullWidth: true } };
export const KdsSurface: Story = {
  args: { size: 'tender', children: 'Bump' },
  parameters: { surface: 'kds' },
};
