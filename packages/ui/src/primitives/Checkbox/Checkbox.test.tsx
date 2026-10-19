import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { Checkbox } from './Checkbox.js';

describe('Checkbox', () => {
  it('is a named checkbox', () => {
    renderUi(<Checkbox label="Email receipt" />);
    expect(screen.getByRole('checkbox', { name: 'Email receipt' })).not.toBeChecked();
  });

  it('toggles by click, label click and Space', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderUi(<Checkbox label="Email" onChange={onChange} />);
    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('checkbox')).toBeChecked();
    await user.click(screen.getByText('Email'));
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    await user.keyboard(' ');
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('supports defaultChecked and controlled checked', async () => {
    const user = userEvent.setup();
    function Controlled() {
      const [checked, setChecked] = useState(true);
      return (
        <Checkbox
          label="X"
          checked={checked}
          onChange={(e) => setChecked(e.currentTarget.checked)}
        />
      );
    }
    renderUi(<Controlled />);
    expect(screen.getByRole('checkbox')).toBeChecked();
    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('exposes the indeterminate state', () => {
    const { rerender } = renderUi(<Checkbox label="All" indeterminate />);
    const box = screen.getByRole('checkbox');
    expect(box).toBePartiallyChecked();
    rerender(<Checkbox label="All" indeterminate={false} />);
    expect(box).not.toBePartiallyChecked();
  });

  it('clears indeterminate when clicked (native behaviour)', async () => {
    const user = userEvent.setup();
    renderUi(<Checkbox label="All" indeterminate />);
    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('describes by its hint', () => {
    renderUi(<Checkbox label="Email" hint="Goes to the customer record address" />);
    expect(screen.getByRole('checkbox', { name: 'Email' })).toHaveAccessibleDescription(
      'Goes to the customer record address',
    );
  });

  it('marks invalid', () => {
    renderUi(<Checkbox label="Accept" invalid />);
    expect(screen.getByRole('checkbox')).toBeInvalid();
  });

  it('does not toggle when disabled', async () => {
    const user = userEvent.setup();
    renderUi(<Checkbox label="X" disabled />);
    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });

  it('forwards the ref', () => {
    const ref = { current: null as HTMLInputElement | null };
    renderUi(<Checkbox label="X" ref={ref} />);
    expect(ref.current).toBe(screen.getByRole('checkbox'));
  });

  it('accepts aria-label without visible text', () => {
    renderUi(<Checkbox aria-label="Select row 3" />);
    expect(screen.getByRole('checkbox', { name: 'Select row 3' })).toBeInTheDocument();
  });
});
