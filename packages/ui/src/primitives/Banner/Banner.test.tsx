import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { Banner } from './Banner.js';

describe('Banner', () => {
  it.each(['info', 'warning', 'success', 'offline'] as const)(
    '%s tone is a polite status with icon and text',
    (tone) => {
      const { container } = renderUi(<Banner tone={tone}>Heads up</Banner>);
      const banner = screen.getByRole('status');
      expect(banner).toHaveAttribute('data-tone', tone);
      expect(banner).toHaveTextContent('Heads up');
      expect(container.querySelector('svg')).toBeInTheDocument();
    },
  );

  it('danger tone is an alert', () => {
    renderUi(<Banner tone="danger">Terminal disconnected</Banner>);
    expect(screen.getByRole('alert')).toHaveTextContent('Terminal disconnected');
  });

  it('offline variant uses catalogued copy, a red tone and an icon', () => {
    const { container } = renderUi(<Banner variant="offline" />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Offline — tickets from this device only');
    expect(banner).toHaveAttribute('data-tone', 'danger');
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('degraded variant interpolates the station', () => {
    renderUi(<Banner variant="degraded" station="Grill" />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'KDS hub degraded — printing fallback active at Grill',
    );
    expect(screen.getByRole('status')).toHaveAttribute('data-tone', 'warning');
  });

  it('cloud routing and warning variants use amber copy', () => {
    const { rerender } = renderUi(<Banner variant="cloudRouting" />);
    expect(screen.getByRole('status')).toHaveTextContent('Cloud routing — hub unreachable');
    expect(screen.getByRole('status')).toHaveAttribute('data-tone', 'warning');
    rerender(<Banner variant="warning" />);
    expect(screen.getByRole('status')).toHaveTextContent('Connection unstable');
  });

  it('tenants can override variant copy through messages, and children override everything', () => {
    const { rerender } = renderUi(<Banner variant="offline" />, {
      messages: { 'banner.offline': 'No connection — sales are saved on this till' },
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'No connection — sales are saved on this till',
    );
    rerender(<Banner variant="offline">Custom text</Banner>);
    expect(screen.getByRole('status')).toHaveTextContent('Custom text');
  });

  it('renders an action and a dismiss button that works', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const onAction = vi.fn();
    renderUi(
      <Banner
        tone="warning"
        onDismiss={onDismiss}
        action={<button onClick={onAction}>Retry</button>}
      >
        Sync delayed
      </Banner>,
    );
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('has no dismiss button unless onDismiss is given', () => {
    renderUi(<Banner tone="info">Hello</Banner>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
