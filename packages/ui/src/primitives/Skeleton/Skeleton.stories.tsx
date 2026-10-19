import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';

import { Skeleton, SkeletonGroup } from './Skeleton.js';

const frame: Decorator = (Story) => (
  <SkeletonGroup style={{ maxWidth: 360 }}>
    <Story />
  </SkeletonGroup>
);

const meta = {
  title: 'Primitives/Skeleton',
  component: Skeleton,
  decorators: [frame],
} satisfies Meta<typeof Skeleton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TextLine: Story = {};
export const TextLines: Story = { args: { lines: 3 } };
export const Block: Story = { args: { variant: 'block' } };
export const Circle: Story = { args: { variant: 'circle' } };
export const CustomSize: Story = { args: { variant: 'block', width: 200, height: 40 } };

export const ProductTileLoading: Story = {
  render: () => (
    <SkeletonGroup style={{ maxWidth: 240 }}>
      <Skeleton variant="block" />
      <Skeleton lines={2} />
    </SkeletonGroup>
  ),
};
export const ListRowLoading: Story = {
  render: () => (
    <SkeletonGroup>
      {[0, 1, 2].map((row) => (
        <div key={row} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Skeleton variant="circle" />
          <Skeleton lines={2} />
        </div>
      ))}
    </SkeletonGroup>
  ),
};
