import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { Button } from './Button.js';

describe('Button', () => {
  it('defaults to type=button so it never submits a form by accident', () => {
    renderUi(<Button>Pay</Button>);
    expect(screen.getByRole('button', { name: 'Pay' })).toHaveAttribute('type', 'button');
  });

  it('calls onClick and respects disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { rerender } = renderUi(<Button onClick={onClick}>Pay</Button>);
    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Button onClick={onClick} disabled>
        Pay
      </Button>,
    );
    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('loading disables, sets aria-busy and announces itself', () => {
    renderUi(<Button loading>Save</Button>);
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveTextContent('Loading…');
  });

  it.each(['primary', 'secondary', 'danger', 'ghost'] as const)(
    'renders the %s variant class',
    (variant) => {
      renderUi(<Button variant={variant}>x</Button>);
      expect(screen.getByRole('button')).toHaveClass(`pos-button--${variant}`);
    },
  );

  it('exposes the tender size', () => {
    renderUi(<Button size="tender">Cash</Button>);
    expect(screen.getByRole('button')).toHaveClass('pos-button--tender');
  });

  it('activates from the keyboard', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderUi(<Button onClick={onClick}>Pay</Button>);
    await user.tab();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
