import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { QuantityStepper } from './QuantityStepper.js';

describe('QuantityStepper', () => {
  it('exposes a named group with named buttons and a live readout', () => {
    renderUi(<QuantityStepper defaultValue={2} />);
    expect(screen.getByRole('group', { name: 'Quantity' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decrease quantity' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Increase quantity' })).toBeInTheDocument();
    const readout = screen.getByRole('status');
    expect(readout).toHaveTextContent('2');
    expect(readout).toHaveAttribute('aria-live', 'polite');
  });

  it('increments and decrements uncontrolled and reports onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderUi(<QuantityStepper defaultValue={2} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Increase quantity' }));
    expect(screen.getByRole('status')).toHaveTextContent('3');
    await user.click(screen.getByRole('button', { name: 'Decrease quantity' }));
    await user.click(screen.getByRole('button', { name: 'Decrease quantity' }));
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([3, 2, 1]);
    expect(screen.getByRole('status')).toHaveTextContent('1');
  });

  it('is controlled when value is given', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderUi(<QuantityStepper value={5} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Increase quantity' }));
    expect(onChange).toHaveBeenCalledWith(6);
    expect(screen.getByRole('status')).toHaveTextContent('5');
  });

  it('is inert at the bounds without dropping focus', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderUi(<QuantityStepper value={1} min={1} max={1} onChange={onChange} />);
    const dec = screen.getByRole('button', { name: 'Decrease quantity' });
    const inc = screen.getByRole('button', { name: 'Increase quantity' });
    expect(dec).toHaveAttribute('aria-disabled', 'true');
    expect(inc).toHaveAttribute('aria-disabled', 'true');
    dec.focus();
    await user.keyboard('{Enter}');
    expect(dec).toHaveFocus();
    await user.click(inc);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('operates from the keyboard', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderUi(<QuantityStepper defaultValue={1} onChange={onChange} />);
    await user.tab();
    await user.tab();
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith(2);
  });

  it('supports decimal quantities without float drift', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderUi(
      <QuantityStepper
        defaultValue={0.7}
        step={0.1}
        fractionDigits={3}
        unit="kg"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('0.700kg');
    await user.click(screen.getByRole('button', { name: 'Increase quantity' }));
    expect(onChange).toHaveBeenCalledWith(0.8);
    expect(screen.getByRole('status')).toHaveTextContent('0.800kg');
  });

  it('clamps steps to min and max', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderUi(<QuantityStepper defaultValue={9} step={5} max={10} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Increase quantity' }));
    expect(onChange).toHaveBeenCalledWith(10);
  });

  it('readonly shows the quantity with no buttons', () => {
    renderUi(<QuantityStepper defaultValue={4} readOnly />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('4');
  });

  it('disabled disables both buttons', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderUi(<QuantityStepper defaultValue={4} disabled onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Increase quantity' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Increase quantity' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('accepts a custom group label', () => {
    renderUi(<QuantityStepper defaultValue={1} label="Quantity of Oat Milk 1L" />);
    expect(screen.getByRole('group', { name: 'Quantity of Oat Milk 1L' })).toBeInTheDocument();
  });
});
