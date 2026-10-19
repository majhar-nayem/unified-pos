import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { Radio, RadioGroup } from './Radio.js';

function Group(props: Partial<Parameters<typeof RadioGroup>[0]>) {
  return (
    <RadioGroup label="Receipt" {...props}>
      <Radio value="print" label="Print" />
      <Radio value="email" label="Email" />
      <Radio value="none" label="None" />
    </RadioGroup>
  );
}

describe('RadioGroup', () => {
  it('is a named radiogroup with radios', () => {
    renderUi(<Group />);
    expect(screen.getByRole('radiogroup', { name: 'Receipt' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();
  });

  it('selects on click and reports the value (uncontrolled)', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderUi(<Group onValueChange={onValueChange} />);
    await user.click(screen.getByLabelText('Email'));
    expect(onValueChange).toHaveBeenCalledWith('email');
    expect(screen.getByRole('radio', { name: 'Email' })).toBeChecked();
  });

  it('honours defaultValue and controlled value', () => {
    const { rerender } = renderUi(<Group defaultValue="none" />);
    expect(screen.getByRole('radio', { name: 'None' })).toBeChecked();
    rerender(<Group value="print" onValueChange={() => {}} />);
    expect(screen.getByRole('radio', { name: 'Print' })).toBeChecked();
  });

  it('does not change a controlled group unless the parent updates', async () => {
    const user = userEvent.setup();
    renderUi(<Group value="print" onValueChange={() => {}} />);
    await user.click(screen.getByLabelText('Email'));
    expect(screen.getByRole('radio', { name: 'Print' })).toBeChecked();
  });

  it('moves selection with the arrow keys', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderUi(<Group defaultValue="print" onValueChange={onValueChange} />);
    await user.tab();
    expect(screen.getByRole('radio', { name: 'Print' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(onValueChange).toHaveBeenLastCalledWith('email');
    expect(screen.getByRole('radio', { name: 'Email' })).toHaveFocus();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(onValueChange).toHaveBeenLastCalledWith('none');
  });

  it('describes the group by its hint and error and marks invalid', () => {
    renderUi(<Group hint="This sale only" error="Choose one" />);
    const group = screen.getByRole('radiogroup');
    expect(group).toHaveAccessibleDescription('This sale only Choose one');
    expect(group).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows required and optional markers', () => {
    const { rerender } = renderUi(<Group required />);
    expect(screen.getByText('*')).toBeInTheDocument();
    expect(screen.getByRole('radiogroup')).toHaveAttribute('aria-required', 'true');
    rerender(<Group optional />);
    expect(screen.getByText('(optional)')).toBeInTheDocument();
  });

  it('disables the group and individual radios', () => {
    const { rerender } = renderUi(<Group disabled />);
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    rerender(
      <RadioGroup label="G">
        <Radio value="a" label="A" disabled />
        <Radio value="b" label="B" />
      </RadioGroup>,
    );
    expect(screen.getByRole('radio', { name: 'A' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'B' })).toBeEnabled();
  });

  it('shares one name across the radios', () => {
    renderUi(<Group name="receipt" />);
    for (const radio of screen.getAllByRole('radio'))
      expect(radio).toHaveAttribute('name', 'receipt');
  });

  it('describes a radio by its own hint', () => {
    renderUi(
      <RadioGroup label="G">
        <Radio value="a" label="A" hint="Needs an email" />
      </RadioGroup>,
    );
    expect(screen.getByRole('radio', { name: 'A' })).toHaveAccessibleDescription('Needs an email');
  });

  it('orients horizontally', () => {
    const { container } = renderUi(<Group orientation="horizontal" />);
    expect(container.querySelector('.pos-radio-group__items--horizontal')).not.toBeNull();
  });
});
