import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { CartLine, CartLineList } from './CartLine.js';

const base = {
  name: 'Oat Milk 1L',
  quantity: 2,
  unitPriceMinor: 450,
  lineTotalMinor: 900,
} as const;

describe('CartLine', () => {
  it('formats money exactly from minor units', () => {
    renderUi(<CartLine {...base} unitPriceMinor={3286} lineTotalMinor={3286} quantity={1} />);
    expect(screen.getByText('1 × $32.86')).toBeInTheDocument();
    expect(screen.getByText('$32.86', { selector: '.pos-cart-line__total' })).toBeInTheDocument();
  });

  it('shows quantity times unit price and the line total', () => {
    renderUi(<CartLine {...base} />);
    expect(screen.getByText('2 × $4.50')).toBeInTheDocument();
    expect(screen.getByText('$9.00')).toBeInTheDocument();
  });

  it('shows modifier lines and a tax note', () => {
    renderUi(<CartLine {...base} details={['Large', 'Oat milk']} taxInclusive />);
    expect(screen.getByText('Large')).toBeInTheDocument();
    expect(screen.getByText('Oat milk')).toBeInTheDocument();
    expect(screen.getByText('Includes tax')).toBeInTheDocument();
  });

  it('renders discounts as negative signed amounts regardless of input sign', () => {
    renderUi(
      <CartLine
        {...base}
        discounts={[
          { label: 'PROMO 2-for-8', amountMinor: 100 },
          { label: 'Staff', amountMinor: -50 },
        ]}
      />,
    );
    expect(screen.getByText('PROMO 2-for-8')).toBeInTheDocument();
    expect(screen.getByText('-$1.00')).toBeInTheDocument();
    expect(screen.getByText('-$0.50')).toBeInTheDocument();
  });

  it('shows weighed quantities with the unit', () => {
    renderUi(
      <CartLine
        name="Bananas"
        quantity={0.842}
        quantityFractionDigits={3}
        unitLabel="kg"
        unitPriceMinor={399}
        lineTotalMinor={336}
      />,
    );
    expect(screen.getByText('0.842 kg @ $3.99')).toBeInTheDocument();
  });

  it.each([
    ['voided', 'Voided'],
    ['unsent', 'Not sent'],
    ['sent', 'Sent'],
    ['pending-approval', 'Awaiting approval'],
  ] as const)('shows the %s state as text, not colour alone', (state, label) => {
    renderUi(<CartLine {...base} state={state} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('keeps the full name in the title when it is long', () => {
    const name = 'Organic Cold-Pressed Extra Virgin Olive Oil 750ml Gift Pack';
    renderUi(<CartLine {...base} name={name} />);
    expect(screen.getByText(name)).toHaveAttribute('title', name);
  });

  it('is a toggle button when onSelect is given', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderUi(<CartLine {...base} onSelect={onSelect} selected />);
    const row = screen.getByRole('button', { pressed: true });
    await user.click(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('renders a stepper and actions beside a standalone row', async () => {
    const user = userEvent.setup();
    const onQuantityChange = vi.fn();
    renderUi(
      <CartLine
        {...base}
        onQuantityChange={onQuantityChange}
        actions={<button type="button">Void line</button>}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Increase quantity' }));
    expect(onQuantityChange).toHaveBeenCalledWith(3);
    expect(screen.getByRole('button', { name: 'Void line' })).toBeInTheDocument();
  });
});

function Harness({ onSelectedIdChange }: { onSelectedIdChange?: (id: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <CartLineList
      selectedId={selected}
      onSelectedIdChange={(id) => {
        setSelected(id);
        onSelectedIdChange?.(id);
      }}
      selectedActions={<button type="button">Void</button>}
    >
      <CartLine
        lineId="a"
        name="Oat Milk 1L"
        quantity={1}
        unitPriceMinor={450}
        lineTotalMinor={450}
      />
      <CartLine
        lineId="b"
        name="Sourdough Loaf"
        quantity={1}
        unitPriceMinor={800}
        lineTotalMinor={800}
      />
      <CartLine
        lineId="c"
        name="Coffee Beans"
        quantity={1}
        unitPriceMinor={1400}
        lineTotalMinor={1400}
      />
    </CartLineList>
  );
}

describe('CartLineList', () => {
  it('is a named listbox of options', () => {
    renderUi(<Harness />);
    const list = screen.getByRole('listbox', { name: 'Cart lines' });
    expect(within(list).getAllByRole('option')).toHaveLength(3);
  });

  it('has a single tab stop that starts on the first line', () => {
    renderUi(<Harness />);
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
  });

  it('moves focus with the arrow keys, Home and End without selecting', async () => {
    const user = userEvent.setup();
    const onSelectedIdChange = vi.fn();
    renderUi(<Harness onSelectedIdChange={onSelectedIdChange} />);
    const [a, b, c] = screen.getAllByRole('option');
    await user.tab();
    expect(a).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(b).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(c).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(b).toHaveFocus();
    await user.keyboard('{Home}');
    expect(a).toHaveFocus();
    await user.keyboard('{End}');
    expect(c).toHaveFocus();
    expect(onSelectedIdChange).not.toHaveBeenCalled();
    // roving: the focused option is now the tab stop
    expect(c).toHaveAttribute('tabindex', '0');
    expect(a).toHaveAttribute('tabindex', '-1');
  });

  it('selects with Enter and Space and exposes aria-selected', async () => {
    const user = userEvent.setup();
    const onSelectedIdChange = vi.fn();
    renderUi(<Harness onSelectedIdChange={onSelectedIdChange} />);
    await user.tab();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onSelectedIdChange).toHaveBeenLastCalledWith('b');
    const [a, b] = screen.getAllByRole('option');
    expect(b).toHaveAttribute('aria-selected', 'true');
    expect(a).toHaveAttribute('aria-selected', 'false');
    await user.keyboard('{ArrowUp} ');
    expect(onSelectedIdChange).toHaveBeenLastCalledWith('a');
  });

  it('selects on click and enters on the selected line', async () => {
    const user = userEvent.setup();
    renderUi(<Harness />);
    await user.click(screen.getAllByRole('option')[2]!);
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps the selected-line actions outside the listbox', () => {
    renderUi(<Harness />);
    const group = screen.getByRole('group', { name: 'Actions for the selected line' });
    expect(within(group).getByRole('button', { name: 'Void' })).toBeInTheDocument();
    expect(screen.getByRole('listbox')).not.toContainElement(group);
  });

  it('shows an empty state without a listbox when there are no lines', () => {
    renderUi(<CartLineList />);
    expect(screen.getByText('No items in the cart')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('works uncontrolled', async () => {
    const user = userEvent.setup();
    renderUi(
      <CartLineList defaultSelectedId="b">
        <CartLine lineId="a" name="A" quantity={1} unitPriceMinor={100} lineTotalMinor={100} />
        <CartLine lineId="b" name="B" quantity={1} unitPriceMinor={100} lineTotalMinor={100} />
      </CartLineList>,
    );
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('tabindex', '0');
    await user.click(screen.getAllByRole('option')[0]!);
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
  });
});
