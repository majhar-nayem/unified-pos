import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect } from 'react';

import { Button } from '../Button/Button.js';

import { ToastProvider, useToast, type ToastOptions, type ToastPlacement } from './Toast.js';

/**
 * Toasts are transient. Design rule: state is NEVER ONLY a toast. A payment result, a failed sync or an
 * offline transition must also show in the page (StatusPill, Banner, list state), because a toast can
 * disappear, or be missed, before anyone reads it.
 *
 * These stories use `durationMs: 0` so the toast stays visible; the default auto-dismisses after 5 s
 * (8 s for danger) and pauses while hovered or focused.
 */
const meta = {
  title: 'Primitives/Toast',
  component: ToastProvider,
  parameters: { layout: 'fullscreen' },
  args: { children: null },
} satisfies Meta<typeof ToastProvider>;
export default meta;
type Story = StoryObj<typeof meta>;

function Fire({ toasts }: { toasts: readonly ToastOptions[] }) {
  const { toast, dismissAll } = useToast();
  useEffect(() => {
    for (const options of toasts) toast({ durationMs: 0, ...options });
    return dismissAll;
  }, [toast, dismissAll, toasts]);
  return <p>The toast region is anchored to the viewport.</p>;
}

function Demo({
  toasts,
  placement,
}: {
  toasts: readonly ToastOptions[];
  placement?: ToastPlacement;
}) {
  return (
    <ToastProvider {...(placement ? { placement } : {})}>
      <Fire toasts={toasts} />
    </ToastProvider>
  );
}

const info: ToastOptions[] = [
  { tone: 'info', title: 'Receipt emailed', description: 'Sent to sam@example.com' },
];
const success: ToastOptions[] = [{ tone: 'success', title: 'Order saved' }];
const warning: ToastOptions[] = [
  {
    tone: 'warning',
    title: 'Printer low on paper',
    description: 'Kitchen printer 2 will stop soon.',
  },
];
const danger: ToastOptions[] = [
  {
    tone: 'danger',
    title: 'Could not sync 3 sales',
    description: 'They stay on this device until the connection returns.',
  },
];
const offline: ToastOptions[] = [{ tone: 'offline', title: 'Working offline' }];
const withAction: ToastOptions[] = [
  { tone: 'success', title: 'Item voided', action: { label: 'Undo', onClick: () => undefined } },
];
const stacked: ToastOptions[] = [...success, ...warning, ...danger];

export const Info: Story = { render: () => <Demo toasts={info} /> };
export const Success: Story = { render: () => <Demo toasts={success} /> };
export const Warning: Story = { render: () => <Demo toasts={warning} /> };
export const Danger: Story = { render: () => <Demo toasts={danger} /> };
export const Offline: Story = { render: () => <Demo toasts={offline} /> };
export const WithAction: Story = { render: () => <Demo toasts={withAction} /> };
export const Stacked: Story = { render: () => <Demo toasts={stacked} /> };
export const TopEnd: Story = { render: () => <Demo toasts={success} placement="top-end" /> };
export const BottomCenter: Story = {
  render: () => <Demo toasts={success} placement="bottom-center" />,
};

function Trigger() {
  const { toast } = useToast();
  return (
    <Button
      onClick={() =>
        toast({ tone: 'success', title: 'Saved', description: 'Auto-dismisses in 5 seconds.' })
      }
    >
      Show toast
    </Button>
  );
}
export const InteractiveAutoDismiss: Story = {
  render: () => (
    <ToastProvider>
      <Trigger />
    </ToastProvider>
  ),
};
