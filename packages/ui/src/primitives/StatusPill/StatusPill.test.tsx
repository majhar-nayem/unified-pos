import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderUi } from '../../test/render.js';

import { Badge, StatusPill } from './StatusPill.js';

describe('StatusPill', () => {
  it('always renders a label and an icon, never colour alone', () => {
    const { container } = renderUi(<StatusPill tone="danger" label="Declined" />);
    expect(screen.getByText('Declined')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('takes colours from a status palette', () => {
    const { container } = renderUi(<StatusPill palette="payment-captured" label="Captured" />);
    expect(container.querySelector('[data-palette="payment-captured"]')).toBeInTheDocument();
  });
});

describe('Badge', () => {
  it('caps the displayed count and keeps the full description for screen readers', () => {
    renderUi(<Badge count={120} max={99} label="120 unsynced sales" />);
    const badge = screen.getByRole('status', { name: '120 unsynced sales' });
    expect(badge).toHaveTextContent('99+');
  });
});
