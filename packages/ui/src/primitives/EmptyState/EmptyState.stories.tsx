import type { Meta, StoryObj } from '@storybook/react-vite';

import { Icon } from '../../foundation/Icon.js';
import { Button } from '../Button/Button.js';

import { EmptyState } from './EmptyState.js';

const meta = {
  title: 'Primitives/EmptyState',
  component: EmptyState,
  args: {
    title: 'No orders yet',
    description: 'Orders appear here as soon as the first sale is rung up.',
  },
} satisfies Meta<typeof EmptyState>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const WithAction: Story = { args: { action: <Button>Start a sale</Button> } };
export const CustomIcon: Story = {
  args: {
    icon: <Icon name="search" size="1.5em" />,
    title: 'No results for "latte"',
    description: 'Check the spelling or search by barcode.',
    action: <Button variant="secondary">Clear search</Button>,
  },
};
export const NoIcon: Story = { args: { icon: null } };
export const TitleOnlyDefaultCopy: Story = { args: { title: undefined, description: undefined } };
export const AdminSurface: Story = { parameters: { surface: 'admin' } };
