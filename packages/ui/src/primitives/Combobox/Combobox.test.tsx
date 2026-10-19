import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { Combobox, type ComboboxOption, type ComboboxProps } from './Combobox.js';

const options: ComboboxOption[] = [
  { value: 'cappuccino', label: 'Cappuccino' },
  { value: 'flat-white', label: 'Flat white' },
  { value: 'latte', label: 'Latte' },
  { value: 'mocha', label: 'Mocha', disabled: true },
];

function setup(props: Partial<ComboboxProps> = {}) {
  return renderUi(<Combobox label="Product" options={options} {...props} />);
}

describe('Combobox', () => {
  it('exposes combobox semantics, closed by default', () => {
    setup();
    const input = screen.getByRole('combobox', { name: 'Product' });
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    expect(input).not.toHaveAttribute('aria-controls');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('opens on typing and filters options', async () => {
    const user = userEvent.setup();
    setup();
    const input = screen.getByRole('combobox');
    await user.type(input, 'la');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    const listbox = screen.getByRole('listbox', { name: 'Product' });
    expect(input).toHaveAttribute('aria-controls', listbox.id);
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Flat white', 'Latte']);
  });

  it('highlights the first match while typing and selects it with Enter', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    setup({ onSelect });
    const input = screen.getByRole('combobox');
    await user.type(input, 'latt');
    const first = screen.getByRole('option', { name: 'Latte' });
    expect(input).toHaveAttribute('aria-activedescendant', first.id);
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith(options[2]);
    expect(input).toHaveValue('Latte');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('navigates with arrow keys, skipping disabled options and wrapping', async () => {
    const user = userEvent.setup();
    setup();
    const input = screen.getByRole('combobox');
    await user.click(input);
    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: 'Cappuccino' }).id,
    );
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(input).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: 'Latte' }).id,
    );
    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: 'Cappuccino' }).id,
    );
    await user.keyboard('{ArrowUp}');
    expect(input).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: 'Latte' }).id,
    );
  });

  it('opens with ArrowDown when closed', async () => {
    const user = userEvent.setup();
    setup();
    const input = screen.getByRole('combobox');
    await user.tab();
    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-activedescendant');
  });

  it('Escape closes the popup without selecting', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    setup({ onSelect });
    await user.type(screen.getByRole('combobox'), 'la');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'false');
  });

  it('selects with a click and keeps focus in the input', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    setup({ onSelect });
    const input = screen.getByRole('combobox');
    await user.click(input);
    await user.click(screen.getByRole('option', { name: 'Flat white' }));
    expect(onSelect).toHaveBeenCalledWith(options[1]);
    expect(input).toHaveValue('Flat white');
    expect(input).toHaveFocus();
  });

  it('does not select disabled options', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    setup({ onSelect });
    await user.click(screen.getByRole('combobox'));
    const mocha = screen.getByRole('option', { name: 'Mocha' });
    expect(mocha).toHaveAttribute('aria-disabled', 'true');
    await user.click(mocha);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('marks the selected option', async () => {
    const user = userEvent.setup();
    setup({ defaultValue: 'latte' });
    const input = screen.getByRole('combobox');
    expect(input).toHaveValue('Latte');
    await user.click(input);
    expect(screen.getByRole('option', { name: 'Latte' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'Cappuccino' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(screen.getAllByRole('option')).toHaveLength(4);
  });

  it('reverts typed text to the selection on blur', async () => {
    const user = userEvent.setup();
    setup({ defaultValue: 'latte' });
    const input = screen.getByRole('combobox');
    await user.clear(input);
    await user.type(input, 'xyz');
    await user.tab();
    expect(input).toHaveValue('Latte');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows the empty state through t() and announces it', async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByRole('combobox'), 'zzz');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getAllByText('No results').length).toBeGreaterThan(0);
    expect(screen.getByRole('status')).toHaveTextContent('No results');
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'false');
  });

  it('accepts a custom empty message', () => {
    setup({ defaultOpen: true, options: [], emptyMessage: 'Nothing here' });
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('announces the result count', async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByRole('combobox'), 'la');
    expect(screen.getByRole('status')).toHaveTextContent('2 results available');
  });

  it('shows a static loading indicator and marks the input busy', () => {
    setup({ defaultOpen: true, loading: true, options: [] });
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Loading results…');
    expect(
      screen.getByText('Loading results…', { selector: 'span:not(.pos-sr-only)' }),
    ).toBeInTheDocument();
  });

  it('keeps showing options while loading more', () => {
    setup({ defaultOpen: true, loading: true });
    expect(screen.getAllByRole('option')).toHaveLength(4);
    expect(screen.getByRole('status')).toHaveTextContent('Loading results…');
  });

  it('does not filter when filter is false (caller filters)', async () => {
    const user = userEvent.setup();
    setup({ filter: false });
    await user.type(screen.getByRole('combobox'), 'zzz');
    expect(screen.getAllByRole('option')).toHaveLength(4);
  });

  it('supports a custom filter', async () => {
    const user = userEvent.setup();
    setup({ filter: (option, query) => option.value.startsWith(query) });
    await user.type(screen.getByRole('combobox'), 'flat');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Flat white']);
  });

  it('supports controlled value and inputValue', async () => {
    const user = userEvent.setup();
    const onInputChange = vi.fn();
    function Controlled() {
      const [value, setValue] = useState<string | null>('latte');
      const [text, setText] = useState('Latte');
      return (
        <Combobox
          label="Product"
          options={options}
          value={value}
          inputValue={text}
          onInputChange={(next) => {
            onInputChange(next);
            setText(next);
          }}
          onSelect={(option) => setValue(option.value)}
        />
      );
    }
    renderUi(<Controlled />);
    const input = screen.getByRole('combobox');
    expect(input).toHaveValue('Latte');
    await user.clear(input);
    await user.type(input, 'cap');
    expect(onInputChange).toHaveBeenLastCalledWith('cap');
    await user.keyboard('{Enter}');
    expect(input).toHaveValue('Cappuccino');
    await user.click(input);
    expect(screen.getByRole('option', { name: 'Cappuccino' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('shows hint and error in the accessible description and marks invalid', () => {
    setup({ hint: 'Name or SKU', error: 'Choose a product' });
    const input = screen.getByRole('combobox');
    expect(input).toHaveAccessibleDescription('Name or SKU Choose a product');
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('is inert when disabled or readOnly', async () => {
    const user = userEvent.setup();
    const { rerender } = setup({ disabled: true });
    expect(screen.getByRole('combobox')).toBeDisabled();
    rerender(<Combobox label="Product" options={options} readOnly />);
    await user.click(screen.getByRole('combobox'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('forwards the ref and required', () => {
    const ref = { current: null as HTMLInputElement | null };
    setup({ ref, required: true });
    expect(ref.current).toBe(screen.getByRole('combobox'));
    expect(screen.getByRole('combobox')).toBeRequired();
  });
});
