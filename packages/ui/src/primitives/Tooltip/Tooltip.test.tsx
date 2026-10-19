import { act, fireEvent, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';
import { Dialog } from '../Dialog/Dialog.js';

import { Tooltip } from './Tooltip.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('Tooltip', () => {
  it('is hidden until hovered or focused', () => {
    renderUi(
      <Tooltip content="Reprint">
        <button>Print</button>
      </Tooltip>,
    );
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print' })).not.toHaveAttribute('aria-describedby');
  });

  it('shows on keyboard focus with aria-describedby and hides on blur', async () => {
    const user = userEvent.setup();
    renderUi(
      <Tooltip content="Reprint last receipt">
        <button>Print</button>
      </Tooltip>,
    );
    await user.tab();
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('Reprint last receipt');
    expect(screen.getByRole('button', { name: 'Print' })).toHaveAccessibleDescription(
      'Reprint last receipt',
    );
    await user.tab();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('shows after a short hover delay and hides on mouse leave', () => {
    vi.useFakeTimers();
    renderUi(
      <Tooltip content="Hint" delayMs={100}>
        <button>Print</button>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: 'Print' });
    fireEvent.mouseEnter(button);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.mouseLeave(button);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('stays open while the pointer moves onto the tooltip itself', () => {
    vi.useFakeTimers();
    renderUi(
      <Tooltip content="Hint" delayMs={0}>
        <button>Print</button>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: 'Print' });
    fireEvent.mouseEnter(button);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    fireEvent.mouseLeave(button);
    fireEvent.mouseEnter(screen.getByRole('tooltip'));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('dismisses with Escape without closing a surrounding dialog', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderUi(
      <Dialog open onClose={onClose} title="Settings">
        <Tooltip content="Hint">
          <button>Print</button>
        </Tooltip>
      </Dialog>,
    );
    await user.click(screen.getByRole('button', { name: 'Print' }));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders into the UiProvider root and supports both placements', () => {
    const { container, rerender } = renderUi(
      <Tooltip content="Hint" defaultOpen placement="bottom">
        <button>Print</button>
      </Tooltip>,
    );
    expect(container.querySelector('.pos-root')).toContainElement(screen.getByRole('tooltip'));
    expect(screen.getByRole('tooltip')).toHaveAttribute('data-placement', 'bottom');
    rerender(
      <Tooltip content="Hint" defaultOpen placement="top">
        <button>Print</button>
      </Tooltip>,
    );
    expect(screen.getByRole('tooltip')).toHaveAttribute('data-placement', 'top');
  });

  it("keeps the child's own handlers and describedby", async () => {
    const user = userEvent.setup();
    const onFocus = vi.fn();
    renderUi(
      <Tooltip content="Hint">
        <button onFocus={onFocus} aria-describedby="elsewhere">
          Print
        </button>
      </Tooltip>,
    );
    expect(screen.getByRole('button')).toHaveAttribute('aria-describedby', 'elsewhere');
    await user.tab();
    expect(onFocus).toHaveBeenCalledTimes(1);
  });
});
