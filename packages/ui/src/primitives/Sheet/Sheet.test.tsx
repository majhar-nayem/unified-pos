import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { Sheet } from './Sheet.js';

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Detail" side="bottom">
        <button>Inside</button>
      </Sheet>
    </>
  );
}

describe('Sheet', () => {
  it('renders nothing while closed and a labelled modal dialog while open', () => {
    const { rerender } = renderUi(
      <Sheet open={false} onClose={() => undefined} title="Detail">
        body
      </Sheet>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerender(
      <Sheet open onClose={() => undefined} title="Detail">
        body
      </Sheet>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Detail' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it.each(['right', 'left', 'bottom'] as const)('anchors to the %s edge', (side) => {
    renderUi(
      <Sheet open onClose={() => undefined} title="Detail" side={side}>
        body
      </Sheet>,
    );
    expect(screen.getByRole('dialog')).toHaveAttribute('data-side', side);
  });

  it('traps focus, closes on Escape and restores focus to the opener', async () => {
    const user = userEvent.setup();
    renderUi(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    expect(screen.getByRole('button', { name: 'Inside' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close panel' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Inside' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('closes via the close button and the scrim, and the scrim can be disabled', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { baseElement, rerender } = renderUi(
      <Sheet open onClose={onClose} title="Detail">
        body
      </Sheet>,
    );
    await user.click(screen.getByRole('button', { name: 'Close panel' }));
    await user.click(baseElement.querySelector('.pos-sheet__scrim')!);
    expect(onClose).toHaveBeenCalledTimes(2);
    rerender(
      <Sheet open onClose={onClose} title="Detail" closeOnScrim={false}>
        body
      </Sheet>,
    );
    await user.click(baseElement.querySelector('.pos-sheet__scrim')!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('locks body scroll while open', () => {
    const { unmount } = renderUi(
      <Sheet open onClose={() => undefined} title="Detail">
        body
      </Sheet>,
    );
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
  });
});
