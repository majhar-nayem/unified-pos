import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { Segmented } from './Segmented.js';

const options = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'gift', label: 'Gift card' },
];

describe('Segmented', () => {
  it('is a named radiogroup of radios', () => {
    renderUi(<Segmented label="Tender" options={options} />);
    expect(screen.getByRole('radiogroup', { name: 'Tender' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('selects the first option by default', () => {
    renderUi(<Segmented label="Tender" options={options} />);
    expect(screen.getByRole('radio', { name: 'Cash' })).toBeChecked();
  });

  it('honours defaultValue', () => {
    renderUi(<Segmented label="Tender" options={options} defaultValue="card" />);
    expect(screen.getByRole('radio', { name: 'Card' })).toBeChecked();
  });

  it('selects on click and calls onValueChange', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderUi(<Segmented label="Tender" options={options} onValueChange={onValueChange} />);
    await user.click(screen.getByText('Card'));
    expect(onValueChange).toHaveBeenCalledWith('card');
    expect(screen.getByRole('radio', { name: 'Card' })).toBeChecked();
  });

  it('moves selection with the arrow keys from a single tab stop', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderUi(<Segmented label="Tender" options={options} onValueChange={onValueChange} />);
    await user.tab();
    expect(screen.getByRole('radio', { name: 'Cash' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(onValueChange).toHaveBeenLastCalledWith('card');
    expect(screen.getByRole('radio', { name: 'Card' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(onValueChange).toHaveBeenLastCalledWith('gift');
  });

  it('is controlled via value', () => {
    const { rerender } = renderUi(<Segmented label="Tender" options={options} value="gift" />);
    expect(screen.getByRole('radio', { name: 'Gift card' })).toBeChecked();
    rerender(<Segmented label="Tender" options={options} value="cash" />);
    expect(screen.getByRole('radio', { name: 'Cash' })).toBeChecked();
  });

  it('disables individual options and the whole group', () => {
    const { rerender } = renderUi(
      <Segmented
        label="Tender"
        options={[...options.slice(0, 2), { value: 'x', label: 'X', disabled: true }]}
      />,
    );
    expect(screen.getByRole('radio', { name: 'X' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Cash' })).toBeEnabled();
    rerender(<Segmented label="Tender" options={options} disabled />);
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  });

  it('renders an option icon', () => {
    const { container } = renderUi(
      <Segmented
        label="Tender"
        options={[
          { value: 'a', label: 'A', icon: 'cash' },
          { value: 'b', label: 'B' },
        ]}
      />,
    );
    expect(container.querySelectorAll('svg')).toHaveLength(1);
  });
});
