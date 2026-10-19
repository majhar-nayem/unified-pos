import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { Card } from './Card.js';

describe('Card', () => {
  it('renders header, body and footer slots', () => {
    renderUi(
      <Card header="Head" footer="Foot">
        Body
      </Card>,
    );
    expect(screen.getByText('Head')).toBeInTheDocument();
    expect(screen.getByText('Body')).toBeInTheDocument();
    expect(screen.getByText('Foot')).toBeInTheDocument();
  });

  it('omits empty slots and supports a semantic root element', () => {
    const { container } = renderUi(<Card as="section">Body</Card>);
    expect(container.querySelector('section.pos-card')).toBeInTheDocument();
    expect(container.querySelector('.pos-card__header')).not.toBeInTheDocument();
    expect(container.querySelector('.pos-card__footer')).not.toBeInTheDocument();
  });

  it('is not interactive by default', () => {
    renderUi(<Card>Body</Card>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('interactive renders a button that works with mouse and keyboard', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderUi(
      <Card interactive onClick={onClick} header="Flat white">
        AUD 4.50
      </Card>,
    );
    const button = screen.getByRole('button', { name: /Flat white/ });
    expect(button).toHaveAttribute('type', 'button');
    await user.click(button);
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('interactive with href renders a link', () => {
    renderUi(
      <Card interactive href="/orders" header="Orders">
        12 open
      </Card>,
    );
    expect(screen.getByRole('link', { name: /Orders/ })).toHaveAttribute('href', '/orders');
  });

  it('respects disabled on an interactive card', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderUi(
      <Card interactive disabled onClick={onClick}>
        Sold out
      </Card>,
    );
    await user.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });
});
