import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Button } from '../Button/Button.js';

import { Sheet } from './Sheet.js';

const meta = {
  title: 'Primitives/Sheet',
  component: Sheet,
  args: {
    open: true,
    onClose: () => undefined,
    title: 'Order 1042',
    children: <p>Items, payments and the audit trail for this order.</p>,
    footer: <Button>Reprint receipt</Button>,
  },
  parameters: { layout: 'fullscreen', surface: 'admin' },
} satisfies Meta<typeof Sheet>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Right: Story = {};
export const Left: Story = { args: { side: 'left' } };
export const Bottom: Story = {
  args: { side: 'bottom', title: 'Select modifiers', footer: <Button>Add to order</Button> },
  parameters: { surface: 'pos' },
};
export const Small: Story = { args: { size: 'sm' } };
export const Large: Story = { args: { size: 'lg' } };
export const WithDescription: Story = { args: { description: 'Opened by Sam at 14:02.' } };
export const LongContent: Story = {
  args: {
    children: Array.from({ length: 30 }, (_, index) => <p key={index}>Audit entry {index + 1}</p>),
  },
};

function InteractiveDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open drawer</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Product detail">
        <p>Edit the product here.</p>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Done
        </Button>
      </Sheet>
    </>
  );
}
export const InteractiveFocusRestore: Story = { render: () => <InteractiveDemo /> };
