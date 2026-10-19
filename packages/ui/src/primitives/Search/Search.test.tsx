import { act, fireEvent, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { Search } from './Search.js';

/** Dispatches one keydown (and its text insertion) with `gap` ms of fake time before it. */
function key(target: Element, k: string, gap: number) {
  act(() => {
    vi.advanceTimersByTime(gap);
  });
  fireEvent.keyDown(target, { key: k });
  if (k.length === 1 && target instanceof HTMLInputElement) {
    fireEvent.change(target, { target: { value: target.value + k } });
  }
}

function burst(target: Element, chars: string, gap: number, terminator = 'Enter') {
  for (const c of chars) key(target, c, gap);
  key(target, terminator, gap);
}

describe('Search', () => {
  it('is a named searchbox with a clear button when there is text', async () => {
    const user = userEvent.setup();
    renderUi(<Search />);
    expect(screen.getByRole('searchbox', { name: 'Search' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
    await user.type(screen.getByRole('searchbox'), 'milk');
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument();
  });

  it('reports typed changes through onQueryChange', async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    renderUi(<Search onQueryChange={onQueryChange} />);
    await user.type(screen.getByRole('searchbox'), 'ab');
    expect(onQueryChange).toHaveBeenNthCalledWith(1, 'a');
    expect(onQueryChange).toHaveBeenNthCalledWith(2, 'ab');
  });

  it('clears with the button, refocuses and notifies', async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    const onClear = vi.fn();
    renderUi(<Search defaultValue="milk" onQueryChange={onQueryChange} onClear={onClear} />);
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByRole('searchbox')).toHaveFocus();
    expect(onQueryChange).toHaveBeenLastCalledWith('');
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('clears with Escape only when there is text', async () => {
    const user = userEvent.setup();
    renderUi(<Search defaultValue="milk" />);
    await user.click(screen.getByRole('searchbox'));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('searchbox')).toHaveValue('');
  });

  it('works controlled', async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    const { rerender } = renderUi(<Search value="abc" onQueryChange={onQueryChange} />);
    expect(screen.getByRole('searchbox')).toHaveValue('abc');
    await user.type(screen.getByRole('searchbox'), 'd');
    expect(onQueryChange).toHaveBeenCalledWith('abcd');
    expect(screen.getByRole('searchbox')).toHaveValue('abc');
    rerender(<Search value="x" />);
    expect(screen.getByRole('searchbox')).toHaveValue('x');
  });

  it('hides the clear button when disabled or readOnly', () => {
    const { rerender } = renderUi(<Search defaultValue="x" disabled />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    rerender(<Search defaultValue="x" readOnly />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('can show a custom visible label', () => {
    renderUi(<Search label="Find a product" hideLabel={false} />);
    expect(screen.getByText('Find a product')).not.toHaveClass('pos-sr-only');
    expect(screen.getByRole('searchbox', { name: 'Find a product' })).toBeInTheDocument();
  });

  describe('human typing', () => {
    it('Enter fires onSubmit with the typed text and never onScan', async () => {
      // A realistic typing pace: user-event's default zero delay is as fast as a scanner.
      const user = userEvent.setup({ delay: 80 });
      const onSubmit = vi.fn();
      const onScan = vi.fn();
      renderUi(<Search onSubmit={onSubmit} onScan={onScan} />);
      await user.type(screen.getByRole('searchbox'), 'latte{Enter}');
      expect(onSubmit).toHaveBeenCalledWith('latte');
      expect(onScan).not.toHaveBeenCalled();
      expect(screen.getByRole('searchbox')).toHaveValue('latte');
    });
  });

  describe('scanner capture', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('fires onScan for a fast burst + Enter and leaves the field as it was', () => {
      const onScan = vi.fn();
      const onSubmit = vi.fn();
      const onQueryChange = vi.fn();
      renderUi(<Search onScan={onScan} onSubmit={onSubmit} onQueryChange={onQueryChange} />);
      const input = screen.getByRole('searchbox');
      burst(input, '9300633', 10);
      expect(onScan).toHaveBeenCalledTimes(1);
      expect(onScan).toHaveBeenCalledWith('9300633');
      expect(onSubmit).not.toHaveBeenCalled();
      expect(input).toHaveValue('');
      expect(onQueryChange).toHaveBeenLastCalledWith('');
    });

    it('restores the text that was in the field before the scan', () => {
      const onScan = vi.fn();
      renderUi(<Search defaultValue="milk" onScan={onScan} />);
      const input = screen.getByRole('searchbox');
      burst(input, '12345', 5);
      expect(onScan).toHaveBeenCalledWith('12345');
      expect(input).toHaveValue('milk');
    });

    it('keeps the scanned code when keepValueOnScan', () => {
      const onScan = vi.fn();
      renderUi(<Search onScan={onScan} keepValueOnScan />);
      const input = screen.getByRole('searchbox');
      burst(input, '12345', 5);
      expect(onScan).toHaveBeenCalledWith('12345');
      expect(input).toHaveValue('12345');
    });

    it('treats slow typing plus Enter as a submit, not a scan', () => {
      const onScan = vi.fn();
      const onSubmit = vi.fn();
      renderUi(<Search onScan={onScan} onSubmit={onSubmit} />);
      const input = screen.getByRole('searchbox');
      burst(input, '12345', 120);
      expect(onScan).not.toHaveBeenCalled();
      expect(onSubmit).toHaveBeenCalledWith('12345');
      expect(input).toHaveValue('12345');
    });

    it('does not scan below minLength and honours a custom minLength', () => {
      const onScan = vi.fn();
      const onSubmit = vi.fn();
      const { rerender } = renderUi(<Search onScan={onScan} onSubmit={onSubmit} />);
      const input = screen.getByRole('searchbox');
      burst(input, '123', 5);
      expect(onScan).not.toHaveBeenCalled();
      expect(onSubmit).toHaveBeenCalledWith('123');
      rerender(<Search onScan={onScan} onSubmit={onSubmit} minLength={2} />);
      fireEvent.change(input, { target: { value: '' } });
      burst(input, '12', 5);
      expect(onScan).toHaveBeenCalledWith('12');
    });

    it('honours maxKeyGapMs', () => {
      const onScan = vi.fn();
      renderUi(<Search onScan={onScan} maxKeyGapMs={200} />);
      burst(screen.getByRole('searchbox'), '12345', 150);
      expect(onScan).toHaveBeenCalledWith('12345');
    });

    it('does not treat a late Enter after a fast burst as a scan', () => {
      const onScan = vi.fn();
      const onSubmit = vi.fn();
      renderUi(<Search onScan={onScan} onSubmit={onSubmit} />);
      const input = screen.getByRole('searchbox');
      for (const c of '12345') key(input, c, 5);
      key(input, 'Enter', 400);
      expect(onScan).not.toHaveBeenCalled();
      expect(onSubmit).toHaveBeenCalledWith('12345');
    });

    it('supports a custom terminator key', () => {
      const onScan = vi.fn();
      const onSubmit = vi.fn();
      renderUi(<Search onScan={onScan} onSubmit={onSubmit} scanTerminator="Tab" />);
      burst(screen.getByRole('searchbox'), '12345', 5, 'Tab');
      expect(onScan).toHaveBeenCalledWith('12345');
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('prevents the terminator default so a surrounding form is not submitted', () => {
      renderUi(<Search onScan={() => {}} />);
      const input = screen.getByRole('searchbox');
      for (const c of '12345') key(input, c, 5);
      act(() => {
        vi.advanceTimersByTime(5);
      });
      const notPrevented = fireEvent.keyDown(input, { key: 'Enter' });
      expect(notPrevented).toBe(false);
    });

    it('scans back to back', () => {
      const onScan = vi.fn();
      renderUi(<Search onScan={onScan} />);
      const input = screen.getByRole('searchbox');
      burst(input, '11111', 5);
      burst(input, '22222', 5);
      expect(onScan).toHaveBeenNthCalledWith(1, '11111');
      expect(onScan).toHaveBeenNthCalledWith(2, '22222');
    });
  });

  describe('captureGlobally', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('captures a scan when nothing editable has focus', () => {
      const onScan = vi.fn();
      renderUi(<Search onScan={onScan} captureGlobally />);
      burst(document.body, '9300633', 10);
      expect(onScan).toHaveBeenCalledWith('9300633');
    });

    it('does nothing globally unless enabled', () => {
      const onScan = vi.fn();
      renderUi(<Search onScan={onScan} />);
      burst(document.body, '9300633', 10);
      expect(onScan).not.toHaveBeenCalled();
    });

    it('ignores bursts typed into another editable element', () => {
      const onScan = vi.fn();
      renderUi(
        <>
          <Search onScan={onScan} captureGlobally />
          <input aria-label="Other" />
        </>,
      );
      burst(screen.getByLabelText('Other'), '9300633', 10);
      expect(onScan).not.toHaveBeenCalled();
    });

    it('still captures when a button has focus, and blocks its activation', () => {
      const onScan = vi.fn();
      renderUi(
        <>
          <Search onScan={onScan} captureGlobally />
          <button type="button">Pay</button>
        </>,
      );
      const button = screen.getByRole('button', { name: 'Pay' });
      for (const c of '9300633') key(button, c, 10);
      act(() => {
        vi.advanceTimersByTime(10);
      });
      const notPrevented = fireEvent.keyDown(button, { key: 'Enter' });
      expect(onScan).toHaveBeenCalledWith('9300633');
      expect(notPrevented).toBe(false);
    });

    it('does not double fire when the search field itself has focus', () => {
      const onScan = vi.fn();
      renderUi(<Search onScan={onScan} captureGlobally />);
      burst(screen.getByRole('searchbox'), '9300633', 10);
      expect(onScan).toHaveBeenCalledTimes(1);
    });

    it('removes the listener on unmount', () => {
      const onScan = vi.fn();
      const { unmount } = renderUi(<Search onScan={onScan} captureGlobally />);
      unmount();
      burst(document.body, '9300633', 10);
      expect(onScan).not.toHaveBeenCalled();
    });
  });
});
