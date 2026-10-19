import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { Keypad, type KeypadProps } from './Keypad.js';

function Controlled(props: KeypadProps) {
  const [value, setValue] = useState(props.defaultValue ?? '');
  return (
    <Keypad
      {...props}
      value={value}
      onChange={(next) => {
        setValue(next);
        props.onChange?.(next);
      }}
    />
  );
}

describe('Keypad', () => {
  it('is a named group of keys', () => {
    renderUi(<Keypad label="Quantity" />);
    expect(screen.getByRole('group', { name: 'Quantity' })).toBeInTheDocument();
    for (const key of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      expect(screen.getByRole('button', { name: key })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Delete last digit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
  });

  it('defaults the group name through t()', () => {
    renderUi(<Keypad />);
    expect(screen.getByRole('group', { name: 'Keypad' })).toBeInTheDocument();
  });

  it('enters digits with taps and reports the string', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderUi(<Controlled onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: '4' }));
    await user.click(screen.getByRole('button', { name: '2' }));
    expect(onChange).toHaveBeenLastCalledWith('42');
    expect(screen.getByRole('status')).toHaveTextContent('42');
  });

  it('backspace removes the last digit and clear empties the value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderUi(<Controlled defaultValue="123" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Delete last digit' }));
    expect(onChange).toHaveBeenLastCalledWith('12');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenLastCalledWith('');
  });

  it('works uncontrolled with defaultValue', async () => {
    const user = userEvent.setup();
    renderUi(<Keypad defaultValue="5" />);
    await user.click(screen.getByRole('button', { name: '6' }));
    expect(screen.getByRole('status')).toHaveTextContent('56');
  });

  it('does not exceed maxLength', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderUi(<Controlled maxLength={2} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: '1' }));
    await user.click(screen.getByRole('button', { name: '2' }));
    await user.click(screen.getByRole('button', { name: '3' }));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent('12');
  });

  it('replaces a leading zero', async () => {
    const user = userEvent.setup();
    renderUi(<Controlled />);
    await user.click(screen.getByRole('button', { name: '0' }));
    await user.click(screen.getByRole('button', { name: '7' }));
    expect(screen.getByRole('status')).toHaveTextContent('7');
  });

  describe('decimal', () => {
    it('adds one decimal point only and limits places', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      renderUi(<Controlled decimal decimalPlaces={2} onChange={onChange} />);
      await user.click(screen.getByRole('button', { name: 'Decimal point' }));
      expect(onChange).toHaveBeenLastCalledWith('0.');
      await user.click(screen.getByRole('button', { name: 'Decimal point' }));
      await user.click(screen.getByRole('button', { name: '2' }));
      await user.click(screen.getByRole('button', { name: '5' }));
      await user.click(screen.getByRole('button', { name: '9' }));
      expect(onChange).toHaveBeenLastCalledWith('0.25');
    });

    it('has no decimal key unless asked', () => {
      renderUi(<Keypad />);
      expect(screen.queryByRole('button', { name: 'Decimal point' })).not.toBeInTheDocument();
    });

    it('shows the locale decimal separator', () => {
      renderUi(<Keypad decimal defaultValue="1.5" />, { locale: 'de-DE' });
      expect(screen.getByRole('status')).toHaveTextContent('1,5');
    });
  });

  describe('amount mode', () => {
    it('enters minor units and formats with the provider currency', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      renderUi(<Controlled mode="amount" onChange={onChange} />);
      expect(screen.getByRole('status')).toHaveTextContent('$0.00');
      await user.click(screen.getByRole('button', { name: '1' }));
      await user.click(screen.getByRole('button', { name: '2' }));
      await user.click(screen.getByRole('button', { name: '5' }));
      expect(onChange).toHaveBeenLastCalledWith('125');
      expect(screen.getByRole('status')).toHaveTextContent('$1.25');
    });

    it('formats with an explicit currency and zero-decimal currencies', () => {
      renderUi(<Keypad mode="amount" currency="JPY" defaultValue="500" />, { locale: 'en-AU' });
      expect(screen.getByRole('status')).toHaveTextContent('500');
      expect(screen.getByRole('status')).not.toHaveTextContent('.');
    });

    it('does not start with zeros', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      renderUi(<Controlled mode="amount" onChange={onChange} />);
      await user.click(screen.getByRole('button', { name: '0' }));
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('pin mode', () => {
    it('masks the value and announces only the count', async () => {
      const user = userEvent.setup();
      const { container } = renderUi(<Controlled mode="pin" />);
      await user.click(screen.getByRole('button', { name: '1' }));
      await user.click(screen.getByRole('button', { name: '9' }));
      const status = screen.getByRole('status');
      expect(status).toHaveTextContent('2 digits entered');
      expect(status).not.toHaveTextContent('19');
      expect(container.textContent).not.toMatch(/19/);
      expect(container.querySelectorAll('.pos-keypad__dot--filled')).toHaveLength(2);
    });

    it('announces singular and empty counts', async () => {
      const user = userEvent.setup();
      renderUi(<Controlled mode="pin" />);
      expect(screen.getByRole('status')).toHaveTextContent('No digits entered');
      await user.click(screen.getByRole('button', { name: '3' }));
      expect(screen.getByRole('status')).toHaveTextContent('1 digit entered');
    });

    it('defaults to six digits', async () => {
      const user = userEvent.setup();
      const { container } = renderUi(<Controlled mode="pin" />);
      expect(container.querySelectorAll('.pos-keypad__dot')).toHaveLength(6);
      for (let i = 0; i < 8; i += 1) await user.click(screen.getByRole('button', { name: '1' }));
      expect(screen.getByRole('status')).toHaveTextContent('6 digits entered');
    });
  });

  describe('action key', () => {
    it('renders and calls onAction with the value', async () => {
      const user = userEvent.setup();
      const onAction = vi.fn();
      renderUi(<Keypad defaultValue="42" actionLabel="Enter" onAction={onAction} />);
      await user.click(screen.getByRole('button', { name: 'Enter' }));
      expect(onAction).toHaveBeenCalledWith('42');
    });

    it('does not fire when actionDisabled', async () => {
      const user = userEvent.setup();
      const onAction = vi.fn();
      renderUi(<Keypad actionLabel="Enter" actionDisabled onAction={onAction} />);
      expect(screen.getByRole('button', { name: 'Enter' })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: 'Enter' }));
      expect(onAction).not.toHaveBeenCalled();
    });
  });

  describe('physical keyboard', () => {
    it('types digits and Backspace while a key has focus', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      renderUi(<Controlled onChange={onChange} />);
      await user.tab();
      await user.keyboard('907');
      expect(onChange).toHaveBeenLastCalledWith('907');
      await user.keyboard('{Backspace}');
      expect(onChange).toHaveBeenLastCalledWith('90');
    });

    it('Enter triggers the action', async () => {
      const user = userEvent.setup();
      const onAction = vi.fn();
      renderUi(<Controlled actionLabel="Enter" onAction={onAction} defaultValue="8" />);
      await user.tab();
      await user.keyboard('{Enter}');
      expect(onAction).toHaveBeenCalledTimes(1);
      expect(onAction).toHaveBeenCalledWith('8');
    });

    it('Enter keeps native activation on the Clear key', async () => {
      const user = userEvent.setup();
      const onAction = vi.fn();
      const onChange = vi.fn();
      renderUi(
        <Controlled actionLabel="Enter" onAction={onAction} onChange={onChange} defaultValue="8" />,
      );
      screen.getByRole('button', { name: 'Clear' }).focus();
      await user.keyboard('{Enter}');
      expect(onAction).not.toHaveBeenCalled();
      expect(onChange).toHaveBeenLastCalledWith('');
    });

    it('accepts the decimal point from the keyboard only when enabled', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const { rerender } = renderUi(<Controlled onChange={onChange} />);
      await user.tab();
      await user.keyboard('1.');
      expect(onChange).toHaveBeenLastCalledWith('1');
      rerender(<Controlled decimal onChange={onChange} />);
      await user.keyboard('.5');
      expect(onChange).toHaveBeenLastCalledWith('1.5');
    });

    it('ignores keys with modifiers', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      renderUi(<Controlled onChange={onChange} />);
      await user.tab();
      await user.keyboard('{Control>}1{/Control}');
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  it('disables every key when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderUi(<Keypad disabled onChange={onChange} actionLabel="Enter" />);
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
    await user.keyboard('1');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('can hide the display and the clear key', () => {
    renderUi(<Keypad hideDisplay showClear={false} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
  });
});
