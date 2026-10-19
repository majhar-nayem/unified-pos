import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('is an alert dialog that focuses the safe action first and cancels on Escape', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Revoke?"
        message="Cannot be undone"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByRole('alertdialog', { name: 'Revoke?' })).toHaveAccessibleDescription(
      'Cannot be undone',
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });

  it('requires a reason when asked and hands it to onConfirm trimmed', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="t"
        message="m"
        confirmLabel="Do it"
        reason={{ label: 'Why', required: true }}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    const confirm = screen.getByRole('button', { name: 'Do it' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/Why/), '  lost  ');
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('lost');
  });

  it('renders nothing when closed', () => {
    render(
      <ConfirmDialog open={false} title="t" message="m" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
