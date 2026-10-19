import type { Meta, StoryObj } from '@storybook/react-vite';

import { IconButton } from './IconButton.js';

const meta = {
  title: 'Primitives/IconButton',
  component: IconButton,
  args: { label: 'Delete line', icon: 'trash' },
} satisfies Meta<typeof IconButton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Secondary: Story = {};
export const Primary: Story = { args: { variant: 'primary', label: 'Add item', icon: 'plus' } };
export const Danger: Story = { args: { variant: 'danger' } };
export const Ghost: Story = { args: { variant: 'ghost', label: 'More actions', icon: 'more' } };
export const Small: Story = { args: { size: 'sm' } };
export const Medium: Story = { args: { size: 'md' } };
export const Large: Story = { args: { size: 'lg' } };
export const Disabled: Story = { args: { disabled: true } };
export const KdsSurface: Story = {
  args: { size: 'lg', label: 'Recall ticket', icon: 'undo' },
  parameters: { surface: 'kds' },
};
