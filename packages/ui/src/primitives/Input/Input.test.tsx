import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { Input } from './Input.js';

describe('Input', () => {
  it('is labelled', () => {
    renderUi(<Input label="Customer name" />);
    expect(screen.getByRole('textbox', { name: 'Customer name' })).toBeInTheDocument();
  });

  it('accepts typing and reports changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderUi(<Input label="Name" onChange={onChange} />);
    await user.type(screen.getByLabelText('Name'), 'Ann');
    expect(screen.getByLabelText('Name')).toHaveValue('Ann');
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('supports controlled value', () => {
    const { rerender } = renderUi(<Input label="Name" value="a" onChange={() => {}} />);
    expect(screen.getByLabelText('Name')).toHaveValue('a');
    rerender(<Input label="Name" value="b" onChange={() => {}} />);
    expect(screen.getByLabelText('Name')).toHaveValue('b');
  });

  it('shows hint and error as the accessible description and marks invalid', () => {
    renderUi(<Input label="Name" hint="Printed on receipts" error="Enter a name" />);
    const input = screen.getByLabelText('Name');
    expect(input).toBeInvalid();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Printed on receipts Enter a name');
  });

  it('keeps caller aria-describedby ids', () => {
    renderUi(
      <>
        <Input label="Name" error="Bad" aria-describedby="extra" />
        <p id="extra">Extra context</p>
      </>,
    );
    expect(screen.getByLabelText('Name')).toHaveAccessibleDescription('Bad Extra context');
  });

  it('can be marked invalid without text', () => {
    renderUi(<Input label="Name" invalid />);
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
  });

  it('is not invalid by default', () => {
    renderUi(<Input label="Name" />);
    expect(screen.getByLabelText('Name')).not.toHaveAttribute('aria-invalid');
  });

  it('marks required and optional', () => {
    const { rerender } = renderUi(<Input label="Name" required />);
    expect(screen.getByLabelText(/Name/)).toBeRequired();
    expect(screen.getByText('*')).toBeInTheDocument();
    rerender(<Input label="Name" optional />);
    expect(screen.getByText('(optional)')).toBeInTheDocument();
  });

  it('supports disabled and readOnly', async () => {
    const user = userEvent.setup();
    const { rerender } = renderUi(<Input label="Name" disabled />);
    expect(screen.getByLabelText('Name')).toBeDisabled();
    rerender(<Input label="Name" readOnly defaultValue="fixed" />);
    await user.type(screen.getByLabelText('Name'), 'x');
    expect(screen.getByLabelText('Name')).toHaveValue('fixed');
    expect(screen.getByLabelText('Name')).toHaveAttribute('readonly');
  });

  it.each([
    ['tel', 'tel'],
    ['email', 'email'],
    ['url', 'url'],
  ] as const)('derives inputMode for %s', (type, mode) => {
    renderUi(<Input label="X" type={type} />);
    expect(screen.getByLabelText('X')).toHaveAttribute('inputmode', mode);
  });

  it('lets inputMode be set explicitly', () => {
    renderUi(<Input label="X" type="number" inputMode="decimal" />);
    expect(screen.getByLabelText('X')).toHaveAttribute('inputmode', 'decimal');
  });

  it('renders each type', () => {
    renderUi(<Input label="Qty" type="number" />);
    expect(screen.getByRole('spinbutton', { name: 'Qty' })).toBeInTheDocument();
  });

  it('renders prefix and suffix', () => {
    renderUi(<Input label="Discount" prefix="$" suffix="AUD" />);
    expect(screen.getByText('$')).toBeInTheDocument();
    expect(screen.getByText('AUD')).toBeInTheDocument();
  });

  it('applies size classes and puts className on the root', () => {
    const { container } = renderUi(<Input label="X" size="lg" className="extra" />);
    expect(container.querySelector('.pos-input--lg')).not.toBeNull();
    expect(container.querySelector('.pos-field.extra')).not.toBeNull();
  });

  it('keeps the label for assistive tech when hidden', () => {
    renderUi(<Input label="Hidden" hideLabel />);
    expect(screen.getByLabelText('Hidden')).toBeInTheDocument();
  });

  it('forwards the ref to the input element', () => {
    const ref = { current: null as HTMLInputElement | null };
    renderUi(<Input label="X" ref={ref} />);
    expect(ref.current).toBe(screen.getByLabelText('X'));
  });
});
