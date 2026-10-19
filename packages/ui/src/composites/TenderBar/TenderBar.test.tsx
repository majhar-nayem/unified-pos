import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { TenderBar } from './TenderBar.js';

const caps = (reached: boolean) => ({ reached, remainingCount: 3, remainingAmountMinor: 25000 });

describe('TenderBar', () => {
  it('shows the total due with exact money formatting', () => {
    renderUi(<TenderBar totalDueMinor={3286} onTender={vi.fn()} />);
    expect(screen.getByText('Total due')).toBeInTheDocument();
    expect(screen.getByText('$32.86')).toBeInTheDocument();
  });

  it('renders cash, card and other as 72px tender buttons', () => {
    renderUi(<TenderBar totalDueMinor={100} onTender={vi.fn()} />);
    for (const name of [/^Cash/, /^Card/, /^Other/]) {
      expect(screen.getByRole('button', { name })).toHaveClass('pos-button--tender');
    }
  });

  it('calls onTender with the tender kind', async () => {
    const user = userEvent.setup();
    const onTender = vi.fn();
    renderUi(<TenderBar totalDueMinor={100} onTender={onTender} />);
    await user.click(screen.getByRole('button', { name: /^Cash/ }));
    await user.click(screen.getByRole('button', { name: /^Card/ }));
    await user.click(screen.getByRole('button', { name: /^Other/ }));
    expect(onTender.mock.calls.map((c) => c[0])).toEqual(['cash', 'card', 'other']);
  });

  it('hides Other when disabled by prop', () => {
    renderUi(<TenderBar totalDueMinor={100} onTender={vi.fn()} other={false} />);
    expect(screen.queryByRole('button', { name: /^Other/ })).not.toBeInTheDocument();
  });

  it('shows the cash rounding delta and a pre-computed amount', () => {
    renderUi(
      <TenderBar
        totalDueMinor={3286}
        roundingMinor={-1}
        cash={{ amountMinor: 3285 }}
        onTender={vi.fn()}
      />,
    );
    expect(screen.getByText('Rounding -$0.01')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Cash/ })).toHaveTextContent('$32.85');
  });

  it('labels the card button plainly when online', () => {
    renderUi(<TenderBar totalDueMinor={100} onTender={vi.fn()} online offlineCaps={caps(false)} />);
    expect(screen.getByRole('button', { name: /^Card/ })).toHaveTextContent(/^Card/);
    expect(screen.queryByText(/terminal may approve offline/)).not.toBeInTheDocument();
  });

  it('relabels the card button offline and shows remaining caps', () => {
    renderUi(
      <TenderBar totalDueMinor={100} onTender={vi.fn()} online={false} offlineCaps={caps(false)} />,
    );
    const card = screen.getByRole('button', {
      name: /^Card \(terminal may approve offline, up to limit\)/,
    });
    expect(card).toBeEnabled();
    expect(card).toHaveTextContent('3 card payments left, up to $250.00');
  });

  it('disables card with a visible reason when offline caps are reached', async () => {
    const user = userEvent.setup();
    const onTender = vi.fn();
    renderUi(
      <TenderBar totalDueMinor={100} onTender={onTender} online={false} offlineCaps={caps(true)} />,
    );
    const card = screen.getByRole('button', { name: /^Card/ });
    expect(card).toBeDisabled();
    const reason = screen.getByText('Offline limit reached — reconnect to continue taking cards');
    expect(reason).toBeVisible();
    expect(card).toHaveAccessibleDescription(
      'Offline limit reached — reconnect to continue taking cards',
    );
    await user.click(card);
    expect(onTender).not.toHaveBeenCalled();
    // cash is unaffected
    expect(screen.getByRole('button', { name: /^Cash/ })).toBeEnabled();
  });

  it('ignores the caps while online', () => {
    renderUi(<TenderBar totalDueMinor={100} onTender={vi.fn()} online offlineCaps={caps(true)} />);
    expect(screen.getByRole('button', { name: /^Card/ })).toBeEnabled();
    expect(screen.queryByText(/Offline limit reached/)).not.toBeInTheDocument();
  });

  it('supports per-tender disabled and hint', async () => {
    const user = userEvent.setup();
    const onTender = vi.fn();
    renderUi(
      <TenderBar
        totalDueMinor={100}
        onTender={onTender}
        card={{ disabled: true, hint: 'Terminal not paired' }}
      />,
    );
    expect(screen.getByRole('button', { name: /^Card/ })).toBeDisabled();
    expect(screen.getByText('Terminal not paired')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Card/ }));
    expect(onTender).not.toHaveBeenCalled();
  });

  it('shows F-key hints as kbd labels', () => {
    renderUi(<TenderBar totalDueMinor={100} onTender={vi.fn()} />);
    expect(screen.getByText('F1', { selector: 'kbd' })).toBeInTheDocument();
    expect(screen.getByText('F2', { selector: 'kbd' })).toBeInTheDocument();
  });

  it('accepts custom shortcut keys', () => {
    renderUi(<TenderBar totalDueMinor={100} onTender={vi.fn()} cash={{ shortcut: 'F5' }} />);
    expect(screen.getByText('F5', { selector: 'kbd' })).toBeInTheDocument();
  });

  describe('shortcuts', () => {
    it('does nothing unless enableShortcuts is set', async () => {
      const user = userEvent.setup();
      const onTender = vi.fn();
      renderUi(<TenderBar totalDueMinor={100} onTender={onTender} />);
      await user.keyboard('{F1}');
      expect(onTender).not.toHaveBeenCalled();
    });

    it('F1 and F2 trigger cash and card from anywhere on the document', async () => {
      const user = userEvent.setup();
      const onTender = vi.fn();
      renderUi(<TenderBar totalDueMinor={100} onTender={onTender} enableShortcuts />);
      await user.keyboard('{F1}{F2}');
      expect(onTender.mock.calls.map((c) => c[0])).toEqual(['cash', 'card']);
    });

    it('is ignored inside editable fields', async () => {
      const user = userEvent.setup();
      const onTender = vi.fn();
      renderUi(
        <>
          <input aria-label="Search" />
          <TenderBar totalDueMinor={100} onTender={onTender} enableShortcuts />
        </>,
      );
      await user.click(screen.getByRole('textbox', { name: 'Search' }));
      await user.keyboard('{F1}');
      expect(onTender).not.toHaveBeenCalled();
    });

    it('does not fire a disabled tender (caps reached)', async () => {
      const user = userEvent.setup();
      const onTender = vi.fn();
      renderUi(
        <TenderBar
          totalDueMinor={100}
          onTender={onTender}
          enableShortcuts
          online={false}
          offlineCaps={caps(true)}
        />,
      );
      await user.keyboard('{F2}');
      expect(onTender).not.toHaveBeenCalled();
      await user.keyboard('{F1}');
      expect(onTender).toHaveBeenCalledWith('cash');
    });

    it('removes the listener on unmount', async () => {
      const user = userEvent.setup();
      const onTender = vi.fn();
      const { unmount } = renderUi(
        <TenderBar totalDueMinor={100} onTender={onTender} enableShortcuts />,
      );
      unmount();
      await user.keyboard('{F1}');
      expect(onTender).not.toHaveBeenCalled();
    });
  });

  it('keeps destructive actions in the leading slot, separate from tenders', () => {
    renderUi(
      <TenderBar
        totalDueMinor={100}
        onTender={vi.fn()}
        leading={<button type="button">Void sale</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Void sale' })).toBeInTheDocument();
  });
});
