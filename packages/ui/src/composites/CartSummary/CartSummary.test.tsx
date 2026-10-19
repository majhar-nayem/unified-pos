import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderUi } from '../../test/render.js';

import { CartSummary } from './CartSummary.js';

const base = { subtotalMinor: 3386, taxMinor: 299, totalMinor: 3286 } as const;

function value(label: string): string {
  const term = screen.getByText(label);
  return term.nextElementSibling?.textContent ?? '';
}

describe('CartSummary', () => {
  it('formats every amount from minor units exactly', () => {
    renderUi(<CartSummary {...base} discountMinor={100} />);
    expect(value('Subtotal')).toBe('$33.86');
    expect(value('Discounts')).toBe('-$1.00');
    expect(value('GST (incl.)')).toBe('$2.99');
    expect(value('Total')).toBe('$32.86');
  });

  it('omits optional rows when absent or zero', () => {
    renderUi(<CartSummary {...base} discountMinor={0} tipMinor={0} roundingMinor={0} />);
    expect(screen.queryByText('Discounts')).not.toBeInTheDocument();
    expect(screen.queryByText('Tip')).not.toBeInTheDocument();
    expect(screen.queryByText('Rounding')).not.toBeInTheDocument();
    expect(screen.queryByText('Paid')).not.toBeInTheDocument();
  });

  it('labels tax by inclusive or exclusive mode', () => {
    const { rerender } = renderUi(<CartSummary {...base} tax="inclusive" />);
    expect(screen.getByText('GST (incl.)')).toBeInTheDocument();
    rerender(<CartSummary {...base} tax="exclusive" taxName="VAT" />);
    expect(screen.getByText('VAT (added)')).toBeInTheDocument();
  });

  it('shows tip, service charge and signed rounding', () => {
    renderUi(
      <CartSummary
        {...base}
        tipMinor={500}
        serviceChargeMinor={339}
        roundingMinor={-1}
        totalMinor={4124}
      />,
    );
    expect(value('Tip')).toBe('$5.00');
    expect(value('Service charge')).toBe('$3.39');
    expect(value('Rounding')).toBe('-$0.01');
  });

  it('shows paid, amount due and change', () => {
    renderUi(<CartSummary {...base} paidMinor={5000} amountDueMinor={0} changeMinor={1714} />);
    expect(value('Paid')).toBe('$50.00');
    expect(value('Amount due')).toBe('$0.00');
    expect(value('Change')).toBe('$17.14');
  });

  it('shows the item count with ICU plurals', () => {
    const { rerender } = renderUi(<CartSummary {...base} itemCount={1} />);
    expect(screen.getByText('1 item')).toBeInTheDocument();
    rerender(<CartSummary {...base} itemCount={4} />);
    expect(screen.getByText('4 items')).toBeInTheDocument();
    rerender(<CartSummary {...base} itemCount={0} />);
    expect(screen.getByText('No items')).toBeInTheDocument();
  });

  it('is a named region with a polite status announcing the grand total', () => {
    const { rerender } = renderUi(<CartSummary {...base} itemCount={4} />);
    const region = screen.getByRole('region', { name: 'Order totals' });
    const status = within(region).getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Total $32.86, 4 items');
    rerender(<CartSummary {...base} itemCount={5} totalMinor={3736} />);
    expect(screen.getByRole('status')).toHaveTextContent('Total $37.36, 5 items');
  });
});
