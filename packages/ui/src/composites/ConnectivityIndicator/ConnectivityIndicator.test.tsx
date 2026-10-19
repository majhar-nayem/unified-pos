import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderUi } from '../../test/render.js';

import { ConnectivityIndicator } from './ConnectivityIndicator.js';

describe('ConnectivityIndicator', () => {
  it.each([
    ['online', 'Online'],
    ['offline', 'Offline'],
    ['degraded', 'Degraded'],
    ['syncing', 'Syncing'],
  ] as const)('shows the %s state as a status with a text label', (status, label) => {
    renderUi(<ConnectivityIndicator status={status} />);
    const el = screen.getByRole('status');
    expect(el).toHaveTextContent(label);
    expect(el).toHaveAttribute('data-status', status);
    expect(el.querySelector('svg')).toBeInTheDocument();
  });

  it('full variant explains the state; offline says sales are saved on the device', () => {
    renderUi(<ConnectivityIndicator status="offline" />);
    expect(screen.getByText('Sales are saved on this device')).toBeInTheDocument();
  });

  it('compact variant shows only the short label, with the detail as a title', () => {
    renderUi(<ConnectivityIndicator status="offline" compact />);
    const el = screen.getByRole('status');
    expect(el).toHaveTextContent(/^Offline$/);
    expect(el).toHaveAttribute('title', 'Sales are saved on this device');
    expect(el).toHaveClass('pos-connectivity--compact');
  });

  it('shows the last sync time formatted for the locale', () => {
    renderUi(<ConnectivityIndicator status="online" lastSyncAt={new Date(2026, 9, 18, 12, 41)} />);
    expect(screen.getByText(/^Last sync 12:41/i)).toBeInTheDocument();
  });

  it('omits last sync in the compact variant', () => {
    renderUi(<ConnectivityIndicator status="online" compact lastSyncAt={Date.now()} />);
    expect(screen.queryByText(/Last sync/)).not.toBeInTheDocument();
  });

  it('is a polite live status that announces changes', () => {
    const { rerender } = renderUi(<ConnectivityIndicator status="online" />);
    expect(screen.getByRole('status')).toHaveTextContent('Online');
    rerender(<ConnectivityIndicator status="offline" />);
    expect(screen.getByRole('status')).toHaveTextContent('Offline');
  });
});
