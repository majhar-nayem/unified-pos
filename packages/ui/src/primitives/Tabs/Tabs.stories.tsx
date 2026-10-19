import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Tabs, type TabItem } from './Tabs.js';

const items: TabItem[] = [
  { value: 'open', label: 'Open', content: <p>Open checks appear here.</p> },
  { value: 'held', label: 'Held', content: <p>Held orders appear here.</p> },
  { value: 'closed', label: 'Closed', content: <p>Closed checks appear here.</p> },
];

const meta = {
  title: 'Primitives/Tabs',
  component: Tabs,
  args: { items, 'aria-label': 'Orders' },
} satisfies Meta<typeof Tabs>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const SecondSelected: Story = { args: { defaultValue: 'held' } };
export const WithCounts: Story = {
  args: {
    items: [
      { value: 'open', label: 'Open', count: 12, content: <p>12 open checks.</p> },
      { value: 'held', label: 'Held', count: 1, content: <p>1 held order.</p> },
      { value: 'closed', label: 'Closed', count: 0, content: <p>None closed yet.</p> },
    ],
  },
};
export const WithDisabledTab: Story = {
  args: {
    items: items.map((item) => (item.value === 'held' ? { ...item, disabled: true } : item)),
  },
};
export const AdminSurface: Story = { parameters: { surface: 'admin' } };

function ControlledDemo() {
  const [value, setValue] = useState('held');
  return (
    <>
      <p>Selected: {value}</p>
      <Tabs items={items} aria-label="Orders" value={value} onValueChange={setValue} />
    </>
  );
}
export const Controlled: Story = { render: () => <ControlledDemo /> };
