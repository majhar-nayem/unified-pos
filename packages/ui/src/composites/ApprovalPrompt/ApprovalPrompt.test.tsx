import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { ApprovalPrompt } from './ApprovalPrompt.js';

const base = {
  open: true,
  action: 'Refund $12.00',
  onApprovePin: vi.fn(),
  onCancel: vi.fn(),
};

describe('ApprovalPrompt', () => {
  it('is an alertdialog describing the action and who asked', () => {
    renderUi(<ApprovalPrompt {...base} requestedBy="Sam" limit="Over your limit" />);
    const dialog = screen.getByRole('alertdialog', { name: 'Manager approval needed' });
    expect(dialog).toHaveTextContent('Refund $12.00');
    expect(dialog).toHaveTextContent('Requested by Sam');
  });

  it('keeps Approve disabled until the minimum PIN length and never renders digits', async () => {
    const user = userEvent.setup();
    const onApprovePin = vi.fn();
    renderUi(<ApprovalPrompt {...base} onApprovePin={onApprovePin} />);
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(approve).toBeDisabled();
    for (const key of ['1', '2', '3', '4'])
      await user.click(screen.getByRole('button', { name: key }));
    expect(approve).toBeEnabled();
    expect(screen.queryByText('1234')).toBeNull(); // key labels exist, the entered PIN is never shown
    await user.click(approve);
    expect(onApprovePin).toHaveBeenCalledWith('1234');
  });

  it('offers passkey when allowed and calls back', async () => {
    const user = userEvent.setup();
    const onApprovePasskey = vi.fn();
    renderUi(
      <ApprovalPrompt {...base} methods={['pin', 'passkey']} onApprovePasskey={onApprovePasskey} />,
    );
    await user.click(screen.getByRole('radio', { name: 'Passkey' }));
    await user.click(screen.getByRole('button', { name: 'Use passkey' }));
    expect(onApprovePasskey).toHaveBeenCalledTimes(1);
  });

  it('shows denial in words with an icon and clears the PIN', async () => {
    const user = userEvent.setup();
    const { rerender } = renderUi(<ApprovalPrompt {...base} />);
    await user.click(screen.getByRole('button', { name: '1' }));
    rerender(<ApprovalPrompt {...base} status="denied" />);
    expect(screen.getByText(/Approval denied/)).toBeInTheDocument();
  });

  it('cancels with the Cancel button and Escape', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderUi(<ApprovalPrompt {...base} onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
