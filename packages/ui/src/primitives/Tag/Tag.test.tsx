import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { Tag } from './Tag.js';

describe('Tag', () => {
  it('renders its label and no remove button by default', () => {
    renderUi(<Tag>Vegan</Tag>);
    expect(screen.getByText('Vegan')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it.each(['neutral', 'brand', 'success', 'warning', 'danger', 'info', 'offline'] as const)(
    'exposes the %s tone',
    (tone) => {
      renderUi(<Tag tone={tone}>x</Tag>);
      expect(screen.getByText('x').parentElement).toHaveAttribute('data-tone', tone);
    },
  );

  it('has an accessible remove button named through t()', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    renderUi(<Tag onRemove={onRemove}>Vegan</Tag>);
    const button = screen.getByRole('button', { name: 'Remove Vegan' });
    await user.click(button);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('removes from the keyboard', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    renderUi(<Tag onRemove={onRemove}>Vegan</Tag>);
    await user.tab();
    await user.keyboard('{Enter}');
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('allows a custom remove label and a generic fallback for non-text content', () => {
    const { rerender } = renderUi(
      <Tag onRemove={() => undefined} removeLabel="Clear dietary filter">
        Vegan
      </Tag>,
    );
    expect(screen.getByRole('button', { name: 'Clear dietary filter' })).toBeInTheDocument();
    rerender(
      <Tag onRemove={() => undefined}>
        <em>Vegan</em>
      </Tag>,
    );
    expect(screen.getByRole('button', { name: 'Remove tag' })).toBeInTheDocument();
  });
});
