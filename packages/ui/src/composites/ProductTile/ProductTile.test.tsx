import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { ProductTile } from './ProductTile.js';

const base = { productId: 'sku-1', name: 'Sourdough Loaf', priceMinor: 800 } as const;

describe('ProductTile', () => {
  it('shows name and exact price and calls onSelect with the product id', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderUi(<ProductTile {...base} priceMinor={3286} onSelect={onSelect} />);
    const tile = screen.getByRole('button', { name: /Sourdough Loaf/ });
    expect(tile).toHaveTextContent('$32.86');
    await user.click(tile);
    expect(onSelect).toHaveBeenCalledWith('sku-1');
  });

  it('activates from the keyboard', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderUi(<ProductTile {...base} onSelect={onSelect} />);
    await user.tab();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('exposes selection as aria-pressed', () => {
    const { rerender } = renderUi(<ProductTile {...base} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false');
    rerender(<ProductTile {...base} selected />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  });

  it('falls back to initials when there is no image', () => {
    renderUi(<ProductTile {...base} name="Coffee Beans 250g" />);
    expect(screen.getByText('CB')).toBeInTheDocument();
  });

  it('renders an image with its alt text', () => {
    renderUi(<ProductTile {...base} imageSrc="x.png" imageAlt="A round loaf" />);
    expect(screen.getByRole('img', { name: 'A round loaf' })).toBeInTheDocument();
  });

  it('shows the price suffix for weighed items', () => {
    renderUi(<ProductTile {...base} priceMinor={399} priceSuffix="/kg" />);
    expect(screen.getByRole('button')).toHaveTextContent('$3.99/kg');
  });

  it('shows low stock as icon + text with the count', () => {
    renderUi(<ProductTile {...base} stock="low" stockCount={3} />);
    expect(screen.getByText('Low stock: 3 left')).toBeInTheDocument();
  });

  it('blocks out-of-stock tiles but keeps them focusable', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderUi(<ProductTile {...base} stock="out" onSelect={onSelect} />);
    const tile = screen.getByRole('button');
    expect(screen.getByText('Out of stock')).toBeInTheDocument();
    expect(tile).toHaveAttribute('aria-disabled', 'true');
    await user.tab();
    expect(tile).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.click(tile);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('allows selling out-of-stock items when configured', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderUi(<ProductTile {...base} stock="out" allowOutOfStock onSelect={onSelect} />);
    await user.click(screen.getByRole('button'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('blocks unavailable (86d) tiles with a visible reason', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderUi(<ProductTile {...base} unavailable onSelect={onSelect} />);
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('button'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('marks age-restricted products with text', () => {
    renderUi(<ProductTile {...base} ageRestricted />);
    expect(screen.getByText('18+')).toBeInTheDocument();
    expect(screen.getByText('Age restricted')).toBeInTheDocument();
  });

  it('renders a badge slot and the full name in a title', () => {
    renderUi(<ProductTile {...base} badge="Promo" />);
    expect(screen.getByText('Promo')).toBeInTheDocument();
    expect(screen.getByText('Sourdough Loaf')).toHaveAttribute('title', 'Sourdough Loaf');
  });
});
