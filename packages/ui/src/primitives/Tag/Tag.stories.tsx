import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Tag } from './Tag.js';

const meta = {
  title: 'Primitives/Tag',
  component: Tag,
  args: { children: 'Vegetarian' },
} satisfies Meta<typeof Tag>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Neutral: Story = {};
export const Brand: Story = { args: { tone: 'brand', children: 'New' } };
export const Success: Story = { args: { tone: 'success', children: 'In stock' } };
export const Warning: Story = { args: { tone: 'warning', children: 'Low stock' } };
export const Danger: Story = { args: { tone: 'danger', children: 'Allergen: nuts' } };
export const Info: Story = { args: { tone: 'info', children: 'Seasonal' } };
export const Offline: Story = { args: { tone: 'offline', children: 'Local only' } };
export const Small: Story = { args: { size: 'sm' } };
export const Removable: Story = { args: { onRemove: () => undefined, children: 'Dine-in' } };
export const LongContent: Story = {
  render: () => (
    <div style={{ width: 160 }}>
      <Tag onRemove={() => undefined}>A very long category name that must truncate</Tag>
    </div>
  ),
};

function RemovableGroup() {
  const [tags, setTags] = useState(['Brunch', 'Vegan', 'Gluten free']);
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {tags.map((tag) => (
        <Tag key={tag} onRemove={() => setTags((current) => current.filter((x) => x !== tag))}>
          {tag}
        </Tag>
      ))}
    </div>
  );
}
export const RemovableGroupInteractive: Story = { render: () => <RemovableGroup /> };
