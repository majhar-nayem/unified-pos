import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Drawer } from './Drawer';

describe('Drawer', () => {
  it('is a modal dialog labelled by its title, closes on Escape and returns focus', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(
      <>
        <button type="button">Open</button>
        <Drawer open={false} onClose={onClose} title="Details">
          <input aria-label="Name" />
        </Drawer>
      </>,
    );
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    rerender(
      <>
        <button type="button">Open</button>
        <Drawer open onClose={onClose} title="Details">
          <input aria-label="Name" />
        </Drawer>
      </>,
    );
    expect(screen.getByRole('dialog', { name: 'Details' })).toHaveAttribute('aria-modal', 'true');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <>
        <button type="button">Open</button>
        <Drawer open={false} onClose={onClose} title="Details">
          <input aria-label="Name" />
        </Drawer>
      </>,
    );
    expect(opener).toHaveFocus();
  });

  it('keeps Tab inside the dialog', async () => {
    const user = userEvent.setup();
    render(
      <Drawer open onClose={vi.fn()} title="T">
        <input aria-label="One" />
        <input aria-label="Two" />
      </Drawer>,
    );
    const dialog = screen.getByRole('dialog');
    for (let i = 0; i < 8; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 8; i++) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });
});
