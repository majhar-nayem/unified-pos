import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { UiProvider } from '../../foundation/UiProvider.js';
import { renderUi } from '../../test/render.js';

import { TicketItem } from './TicketItem.js';

describe('TicketItem', () => {
  it('renders quantity, name and modifiers', () => {
    renderUi(
      <TicketItem
        quantity={2}
        name="Burger Lg"
        modifiers={['+ cheese', 'no onion']}
        notes="rush"
      />,
    );
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('Burger Lg')).toBeInTheDocument();
    expect(screen.getByText('+ cheese')).toBeInTheDocument();
    expect(screen.getByText('no onion')).toBeInTheDocument();
    expect(screen.getByText('rush')).toBeInTheDocument();
  });

  it('shows an allergy band with an icon and the allergen text', () => {
    const { container } = renderUi(<TicketItem quantity={1} name="Burger" allergy="nut" />);
    const band = screen.getByText('ALLERGY: nut').closest('.pos-ticket-item__allergy');
    expect(band).toBeInTheDocument();
    expect(band?.querySelector('svg')).toBeInTheDocument();
    expect(container.querySelectorAll('.pos-ticket-item__allergy')).toHaveLength(1);
  });

  it('joins several allergens into one band', () => {
    renderUi(<TicketItem quantity={1} name="Fish" allergy={['nut', 'dairy', 'egg']} />);
    expect(screen.getByText(/^ALLERGY: nut, dairy,? (and )?egg$/)).toBeInTheDocument();
  });

  it('shows no allergy band without allergens', () => {
    const { container } = renderUi(<TicketItem quantity={1} name="Fish" allergy={[]} />);
    expect(container.querySelector('.pos-ticket-item__allergy')).toBeNull();
  });

  it('strikes a voided item through and shows VOIDED with the time', () => {
    const { container } = renderUi(
      <TicketItem quantity={1} name="Steak" voided voidedAt={new Date(2026, 0, 1, 19, 12)} />,
    );
    expect(container.querySelector('.pos-ticket-item')).toHaveAttribute('data-voided', 'true');
    expect(screen.getByText(/^VOIDED .*7:12/i)).toBeInTheDocument();
  });

  it('shows plain VOIDED when no time is known', () => {
    renderUi(<TicketItem quantity={1} name="Steak" voided />);
    expect(screen.getByText('VOIDED')).toBeInTheDocument();
  });

  it('announces a void assertively as text', () => {
    const { container } = renderUi(<TicketItem quantity={2} name="Steak" voided />);
    const live = container.querySelector('[aria-live="assertive"]');
    expect(live).toHaveTextContent('Item voided: 2 × Steak');
  });

  it('calls onVoidedAnnounce only when an item becomes voided, not on mount', () => {
    const onVoidedAnnounce = vi.fn();
    const ui = (voided: boolean) => (
      <UiProvider>
        <TicketItem quantity={1} name="Steak" voided={voided} onVoidedAnnounce={onVoidedAnnounce} />
      </UiProvider>
    );
    const { rerender } = render(ui(false));
    expect(onVoidedAnnounce).not.toHaveBeenCalled();
    rerender(ui(true));
    expect(onVoidedAnnounce).toHaveBeenCalledOnce();
    rerender(ui(true));
    expect(onVoidedAnnounce).toHaveBeenCalledOnce();

    onVoidedAnnounce.mockClear();
    render(ui(true));
    expect(onVoidedAnnounce).not.toHaveBeenCalled();
  });

  it('marks a changed item and changed modifiers with UPDATED', () => {
    const { container } = renderUi(
      <TicketItem
        quantity={1}
        name="Fish"
        changed
        modifiers={['no lemon', { label: 'extra tartare', changed: true }]}
      />,
    );
    expect(container.querySelector('.pos-ticket-item')).toHaveAttribute('data-changed', 'true');
    expect(screen.getAllByText('UPDATED')).toHaveLength(2);
  });
});
