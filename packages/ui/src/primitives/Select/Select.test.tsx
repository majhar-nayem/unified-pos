import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { Select } from './Select.js';

const options = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
];

describe('Select', () => {
  it('is a labelled combobox-role select with options', () => {
    renderUi(<Select label="Method" options={options} />);
    expect(screen.getByRole('combobox', { name: 'Method' })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('selects an option and calls onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderUi(<Select label="Method" options={options} onChange={onChange} />);
    await user.selectOptions(screen.getByLabelText('Method'), 'card');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Method')).toHaveValue('card');
  });

  it('supports defaultValue and controlled value', () => {
    const { rerender } = renderUi(<Select label="Method" options={options} defaultValue="card" />);
    expect(screen.getByLabelText('Method')).toHaveValue('card');
    rerender(<Select label="Method" options={options} value="cash" onChange={() => {}} />);
    expect(screen.getByLabelText('Method')).toHaveValue('cash');
  });

  it('shows a disabled placeholder that is selected until a choice is made', () => {
    renderUi(<Select label="Method" options={options} placeholder="Choose" />);
    expect(screen.getByLabelText('Method')).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Choose' })).toBeDisabled();
  });

  it('accepts option children', () => {
    renderUi(
      <Select label="Method">
        <option value="a">Alpha</option>
      </Select>,
    );
    expect(screen.getByRole('option', { name: 'Alpha' })).toBeInTheDocument();
  });

  it('describes hint and error and marks invalid', () => {
    renderUi(<Select label="Method" options={options} hint="Pick one" error="Required" />);
    const select = screen.getByLabelText('Method');
    expect(select).toHaveAccessibleDescription('Pick one Required');
    expect(select).toHaveAttribute('aria-invalid', 'true');
  });

  it('supports required, optional and disabled', () => {
    const { rerender } = renderUi(<Select label="Method" options={options} required />);
    expect(screen.getByLabelText(/Method/)).toBeRequired();
    rerender(<Select label="Method" options={options} optional disabled />);
    expect(screen.getByText('(optional)')).toBeInTheDocument();
    expect(screen.getByLabelText(/Method/)).toBeDisabled();
  });

  it('disables individual options', () => {
    renderUi(<Select label="Method" options={[{ value: 'x', label: 'X', disabled: true }]} />);
    expect(screen.getByRole('option', { name: 'X' })).toBeDisabled();
  });
});
