import { act, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { Dialog } from './Dialog.js';

function Harness({ closeOnScrim }: { closeOnScrim?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Edit"
        {...(closeOnScrim === undefined ? {} : { closeOnScrim })}
        footer={<button>Save</button>}
      >
        <input aria-label="Name" />
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('renders nothing while closed', () => {
    renderUi(
      <Dialog open={false} onClose={() => undefined} title="Edit">
        body
      </Dialog>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is a modal dialog labelled by its title and described by the description', () => {
    renderUi(
      <Dialog open onClose={() => undefined} title="Edit customer" description="Careful now">
        body
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Edit customer' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('Careful now');
  });

  it('supports the alertdialog role for confirmations, with no scrim dismiss by default', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { baseElement } = renderUi(
      <Dialog open onClose={onClose} title="Void item?" role="alertdialog">
        body
      </Dialog>,
    );
    expect(screen.getByRole('alertdialog', { name: 'Void item?' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close dialog' })).not.toBeInTheDocument();
    await user.click(baseElement.querySelector('.pos-dialog__scrim')!);
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('portals into the UiProvider root so it inherits theme variables', () => {
    const { container } = renderUi(
      <Dialog open onClose={() => undefined} title="Edit">
        body
      </Dialog>,
    );
    const root = container.querySelector('.pos-root');
    expect(root).toContainElement(screen.getByRole('dialog'));
  });

  it('moves focus in, traps Tab, and restores focus to the opener on close', async () => {
    const user = userEvent.setup();
    renderUi(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    // First tabbable that is not the close button.
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('closes on the close button and on scrim click unless disabled', async () => {
    const user = userEvent.setup();
    const { baseElement, unmount } = renderUi(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(baseElement.querySelector('.pos-dialog__scrim')!);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    unmount();

    const second = renderUi(<Harness closeOnScrim={false} />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(second.baseElement.querySelector('.pos-dialog__scrim')!);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('can disable Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderUi(
      <Dialog open onClose={onClose} title="Edit" closeOnEsc={false}>
        <input aria-label="Name" />
      </Dialog>,
    );
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('honours initialFocusRef', () => {
    const ref = createRef<HTMLButtonElement>();
    renderUi(
      <Dialog open onClose={() => undefined} title="Edit" initialFocusRef={ref}>
        <input aria-label="Name" />
        <button ref={ref}>Second</button>
      </Dialog>,
    );
    expect(screen.getByRole('button', { name: 'Second' })).toHaveFocus();
  });

  it('locks body scroll while open and restores it after', () => {
    const { rerender } = renderUi(
      <Dialog open onClose={() => undefined} title="Edit">
        body
      </Dialog>,
    );
    expect(document.body.style.overflow).toBe('hidden');
    act(() => {
      rerender(
        <Dialog open={false} onClose={() => undefined} title="Edit">
          body
        </Dialog>,
      );
    });
    expect(document.body.style.overflow).toBe('');
  });

  it('only the topmost of stacked dialogs handles Escape', async () => {
    const user = userEvent.setup();
    const outer = vi.fn();
    const inner = vi.fn();
    renderUi(
      <>
        <Dialog open onClose={outer} title="Outer">
          <button>Outer action</button>
        </Dialog>
        <Dialog open onClose={inner} title="Inner">
          <button>Inner action</button>
        </Dialog>
      </>,
    );
    await user.keyboard('{Escape}');
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});
