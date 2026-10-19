import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { IconButton } from './IconButton.js';

describe('IconButton', () => {
  it('is named by its label', () => {
    renderUi(<IconButton label="Delete line" icon="trash" />);
    expect(screen.getByRole('button', { name: 'Delete line' })).toHaveAttribute('type', 'button');
  });

  it('hides the decorative icon', () => {
    const { container } = renderUi(<IconButton label="Delete" icon="trash" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('calls onClick and respects disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { rerender } = renderUi(<IconButton label="Add" icon="plus" onClick={onClick} />);
    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<IconButton label="Add" icon="plus" onClick={onClick} disabled />);
    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('activates from the keyboard', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderUi(<IconButton label="Add" icon="plus" onClick={onClick} />);
    await user.tab();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it.each(['primary', 'secondary', 'danger', 'ghost'] as const)(
    'exposes the %s variant',
    (variant) => {
      renderUi(<IconButton label="x" icon="plus" variant={variant} />);
      expect(screen.getByRole('button')).toHaveClass(`pos-icon-button--${variant}`);
    },
  );

  it.each(['sm', 'md', 'lg'] as const)('exposes the %s size', (size) => {
    renderUi(<IconButton label="x" icon="plus" size={size} />);
    expect(screen.getByRole('button')).toHaveClass(`pos-icon-button--${size}`);
  });

  it('forwards native props and ref', () => {
    const ref = { current: null as HTMLButtonElement | null };
    renderUi(<IconButton label="x" icon="plus" ref={ref} data-testid="ib" />);
    expect(ref.current).toBe(screen.getByTestId('ib'));
  });
});
