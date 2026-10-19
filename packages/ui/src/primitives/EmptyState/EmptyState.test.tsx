import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderUi } from '../../test/render.js';

import { EmptyState } from './EmptyState.js';

describe('EmptyState', () => {
  it('renders title, description and action', () => {
    renderUi(
      <EmptyState title="No orders" description="Nothing yet." action={<button>Start</button>} />,
    );
    expect(screen.getByRole('heading', { name: 'No orders', level: 3 })).toBeInTheDocument();
    expect(screen.getByText('Nothing yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
  });

  it('falls back to catalogued default copy', () => {
    renderUi(<EmptyState />);
    expect(screen.getByRole('heading', { name: 'Nothing here yet' })).toBeInTheDocument();
  });

  it('lets tenants override default copy through messages', () => {
    renderUi(<EmptyState />, { messages: { 'emptyState.title': 'All clear' } });
    expect(screen.getByRole('heading', { name: 'All clear' })).toBeInTheDocument();
  });

  it('supports heading levels and decorative icons', () => {
    const { container, rerender } = renderUi(<EmptyState title="X" headingLevel={2} />);
    expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument();
    expect(container.querySelector('.pos-empty__icon svg')).toHaveAttribute('aria-hidden', 'true');
    rerender(<EmptyState title="X" icon={null} />);
    expect(container.querySelector('.pos-empty__icon')).not.toBeInTheDocument();
  });
});
