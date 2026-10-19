import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';

import { Button } from '../Button/Button.js';

import { Dialog, type DialogProps } from './Dialog.js';

const meta = {
  title: 'Primitives/Dialog',
  component: Dialog,
  args: {
    open: true,
    onClose: () => undefined,
    title: 'Edit customer',
    children: <p>Update the customer details. Changes apply to future orders only.</p>,
    footer: (
      <>
        <Button variant="ghost">Cancel</Button>
        <Button>Save</Button>
      </>
    ),
  },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Dialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Small: Story = { args: { size: 'sm' } };
export const Large: Story = { args: { size: 'lg' } };
export const WithDescription: Story = {
  args: { description: 'Supporting text explains the consequence before the user commits.' },
};
export const NoCloseButton: Story = { args: { showCloseButton: false } };
export const LongContent: Story = {
  args: {
    children: Array.from({ length: 24 }, (_, index) => (
      <p key={index}>
        Receipt line {index + 1}: the body scrolls while the header and footer stay put.
      </p>
    )),
  },
};
export const ConfirmDestructive: Story = {
  args: {
    role: 'alertdialog',
    title: 'Void this sent item?',
    description: 'The kitchen has already received this item. A manager approval is recorded.',
    size: 'sm',
    closeOnScrim: false,
    children: null,
    footer: (
      <>
        <Button variant="secondary">Keep item</Button>
        <Button variant="danger">Void item</Button>
      </>
    ),
  },
};
export const KdsSurface: Story = { parameters: { surface: 'kds' } };

function InteractiveDemo(props: Partial<DialogProps>) {
  const [open, setOpen] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open dialog</Button>
      <Dialog
        title="Rename table"
        {...props}
        open={open}
        onClose={() => setOpen(false)}
        initialFocusRef={nameRef}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => setOpen(false)}>Save</Button>
          </>
        }
      >
        <label>
          Table name <input ref={nameRef} defaultValue="Table 12" />
        </label>
      </Dialog>
    </>
  );
}
export const InteractiveFocusRestore: Story = { render: () => <InteractiveDemo /> };
