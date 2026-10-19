import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderUi } from '../../test/render.js';

import { SyncQueueBadge } from './SyncQueueBadge.js';

describe('SyncQueueBadge', () => {
  it('shows "All synced" with a check when nothing is pending', () => {
    renderUi(<SyncQueueBadge pendingCount={0} />);
    expect(screen.getByText('All synced')).toBeInTheDocument();
  });

  it('renders nothing when hideWhenSynced and there is nothing to show', () => {
    const { container } = renderUi(<SyncQueueBadge pendingCount={0} hideWhenSynced />);
    expect(container.querySelector('.pos-sync-queue')).toBeNull();
  });

  it('describes pending sales with ICU plurals', () => {
    const { rerender } = renderUi(<SyncQueueBadge pendingCount={3} />);
    expect(screen.getByRole('status', { name: '3 sales waiting to sync' })).toHaveTextContent('3');
    rerender(<SyncQueueBadge pendingCount={1} />);
    expect(screen.getByRole('status', { name: '1 sale waiting to sync' })).toBeInTheDocument();
  });

  it('shows the age of the oldest unsynced sale', () => {
    renderUi(<SyncQueueBadge pendingCount={12} oldestAgeSeconds={725} />);
    expect(
      screen.getByRole('status', { name: '12 sales waiting to sync, oldest waiting 12:05' }),
    ).toBeInTheDocument();
  });

  it('caps very large counts like Badge', () => {
    renderUi(<SyncQueueBadge pendingCount={250} />);
    expect(screen.getByRole('status', { name: '250 sales waiting to sync' })).toHaveTextContent(
      '99+',
    );
  });

  it('shows rejected sales as "Needs attention"', () => {
    renderUi(<SyncQueueBadge pendingCount={2} error={{ rejectedCount: 2 }} />);
    expect(
      screen.getByRole('status', { name: '2 sales rejected: Needs attention' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: '2 sales waiting to sync' })).toBeInTheDocument();
    expect(screen.queryByText('All synced')).not.toBeInTheDocument();
  });

  it('ignores an error with zero rejected sales', () => {
    renderUi(<SyncQueueBadge pendingCount={0} error={{ rejectedCount: 0 }} />);
    expect(screen.getByText('All synced')).toBeInTheDocument();
  });

  describe('offline card payments', () => {
    it('shows the expiry countdown via format.duration while offline', () => {
      renderUi(
        <SyncQueueBadge
          pendingCount={2}
          online={false}
          offlinePayments={{ count: 2, soonestExpirySeconds: 5 * 3600 + 120 }}
        />,
      );
      expect(screen.getByText('2 offline card payments, expires in 5:02:00')).toBeInTheDocument();
    });

    it('is amber (warning) under one hour', () => {
      const { container, rerender } = renderUi(
        <SyncQueueBadge
          pendingCount={1}
          online={false}
          offlinePayments={{ count: 1, soonestExpirySeconds: 2700 }}
        />,
      );
      expect(screen.getByText('1 offline card payment, expires in 45:00')).toBeInTheDocument();
      expect(container.querySelector('.pos-pill')).toHaveAttribute('data-tone', 'warning');
      rerender(
        <SyncQueueBadge
          pendingCount={1}
          online={false}
          offlinePayments={{ count: 1, soonestExpirySeconds: 3600 }}
        />,
      );
      expect(container.querySelector('.pos-pill')).toHaveAttribute('data-tone', 'offline');
    });

    it('says the window expired at zero', () => {
      const { container } = renderUi(
        <SyncQueueBadge
          pendingCount={1}
          online={false}
          offlinePayments={{ count: 1, soonestExpirySeconds: 0 }}
        />,
      );
      expect(screen.getByText('1 offline card payment, window expired')).toBeInTheDocument();
      expect(container.querySelector('.pos-pill')).toHaveAttribute('data-tone', 'danger');
    });

    it('shows no countdown while online', () => {
      renderUi(
        <SyncQueueBadge
          pendingCount={2}
          online
          offlinePayments={{ count: 2, soonestExpirySeconds: 2700 }}
        />,
      );
      expect(screen.getByText('2 offline card payments being submitted')).toBeInTheDocument();
      expect(screen.queryByText(/expires in/)).not.toBeInTheDocument();
    });

    it('does not claim "All synced" while offline payments are outstanding', () => {
      renderUi(
        <SyncQueueBadge
          pendingCount={0}
          online={false}
          offlinePayments={{ count: 1, soonestExpirySeconds: 9000 }}
        />,
      );
      expect(screen.queryByText('All synced')).not.toBeInTheDocument();
      expect(screen.getByText(/1 offline card payment, expires in/)).toBeInTheDocument();
    });

    it('re-renders the countdown from props (no internal timer)', () => {
      const { rerender } = renderUi(
        <SyncQueueBadge
          pendingCount={1}
          online={false}
          offlinePayments={{ count: 1, soonestExpirySeconds: 61 }}
        />,
      );
      expect(screen.getByText('1 offline card payment, expires in 1:01')).toBeInTheDocument();
      rerender(
        <SyncQueueBadge
          pendingCount={1}
          online={false}
          offlinePayments={{ count: 1, soonestExpirySeconds: 60 }}
        />,
      );
      expect(screen.getByText('1 offline card payment, expires in 1:00')).toBeInTheDocument();
    });
  });
});
