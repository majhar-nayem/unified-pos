import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { ProductGrid, type ProductGridItem } from './ProductGrid.js';

const products: ProductGridItem[] = Array.from({ length: 10 }, (_, i) => ({
  id: `p${i}`,
  name: `Item ${i}`,
  priceMinor: 100 * (i + 1),
}));

const tiles = () =>
  within(screen.getByRole('group', { name: 'Products' })).getAllByRole('button', { name: /Item/ });

describe('ProductGrid', () => {
  it('renders a named group of tiles with one tab stop', () => {
    renderUi(<ProductGrid products={products} columns={4} />);
    expect(tiles()).toHaveLength(10);
    expect(tiles().map((t) => t.getAttribute('tabindex'))).toEqual(['0', ...Array(9).fill('-1')]);
  });

  it('paginates by pageSize with an indicator and prev/next controls', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    renderUi(
      <ProductGrid products={products} pageSize={4} columns={2} onPageChange={onPageChange} />,
    );
    expect(tiles()).toHaveLength(4);
    expect(screen.getByRole('status')).toHaveTextContent('Page 1 of 3');
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
    expect(screen.getByRole('status')).toHaveTextContent('Page 2 of 3');
    expect(screen.getByText('Item 4')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(tiles()).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('keeps keyboard focus on the pager when a button becomes disabled', async () => {
    const user = userEvent.setup();
    renderUi(<ProductGrid products={products} pageSize={8} columns={4} />);
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByRole('button', { name: 'Previous page' })).toHaveFocus();
  });

  it('hides the pager when everything fits on one page', () => {
    renderUi(<ProductGrid products={products} columns={4} />);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('supports a controlled page', () => {
    renderUi(<ProductGrid products={products} pageSize={4} page={3} columns={2} />);
    expect(screen.getByRole('status')).toHaveTextContent('Page 3 of 3');
    expect(screen.getByText('Item 8')).toBeInTheDocument();
  });

  it('moves focus with arrows by column count, Home and End', async () => {
    const user = userEvent.setup();
    renderUi(<ProductGrid products={products} columns={3} />);
    await user.tab();
    expect(tiles()[0]).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(tiles()[1]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(tiles()[4]).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(tiles()[3]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(tiles()[0]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(tiles()[0]).toHaveFocus();
    await user.keyboard('{End}');
    expect(tiles()[9]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(tiles()[0]).toHaveFocus();
  });

  it('rolls the tab stop to the focused tile', async () => {
    const user = userEvent.setup();
    renderUi(<ProductGrid products={products} columns={3} />);
    await user.tab();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(tiles()[2]).toHaveAttribute('tabindex', '0');
    expect(tiles()[0]).toHaveAttribute('tabindex', '-1');
  });

  it('continues onto the next page with ArrowRight at the last tile and PageDown/PageUp', async () => {
    const user = userEvent.setup();
    renderUi(<ProductGrid products={products} pageSize={4} columns={2} />);
    await user.tab();
    await user.keyboard('{End}{ArrowRight}');
    expect(screen.getByRole('status')).toHaveTextContent('Page 2 of 3');
    expect(tiles()[0]).toHaveFocus();
    await user.keyboard('{PageDown}');
    expect(screen.getByRole('status')).toHaveTextContent('Page 3 of 3');
    expect(tiles()[0]).toHaveFocus();
    await user.keyboard('{PageUp}');
    expect(screen.getByRole('status')).toHaveTextContent('Page 2 of 3');
  });

  it('calls onSelect with the product id and marks the selected tile', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderUi(<ProductGrid products={products} columns={3} onSelect={onSelect} selectedId="p1" />);
    expect(tiles()[1]).toHaveAttribute('aria-pressed', 'true');
    await user.click(tiles()[2]!);
    expect(onSelect).toHaveBeenCalledWith('p2');
  });

  it('shows empty-state text when there are no products', () => {
    renderUi(<ProductGrid products={[]} />);
    expect(screen.getByText('No products to show')).toBeInTheDocument();
  });

  it('applies the fixed column count as a CSS variable', () => {
    renderUi(<ProductGrid products={products} columns={5} />);
    const grid = tiles()[0]!.parentElement!;
    expect(grid.style.getPropertyValue('--pos-product-grid-columns')).toBe('5');
  });
});
