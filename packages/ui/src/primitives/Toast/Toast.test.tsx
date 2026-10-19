import { act, fireEvent, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { ToastProvider, useToast, type ToastApi, type ToastOptions } from './Toast.js';

const captured: { current: ToastApi | null } = { current: null };
function Capture() {
  const api = useToast();
  useEffect(() => {
    captured.current = api;
  });
  return null;
}
const api = new Proxy({} as ToastApi, {
  get: (_target, key: keyof ToastApi) => captured.current![key],
});

function setup() {
  return renderUi(
    <ToastProvider>
      <Capture />
    </ToastProvider>,
  );
}
function fire(options: ToastOptions) {
  act(() => {
    api.toast(options);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Toast', () => {
  it('throws a helpful error outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderUi(<Capture />)).toThrow(/ToastProvider/);
    spy.mockRestore();
  });

  it('has a labelled notifications region with polite and assertive live regions', () => {
    setup();
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(within(region).getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(within(region).getByRole('alert')).toHaveAttribute('aria-live', 'assertive');
  });

  it('announces info politely and danger assertively', () => {
    setup();
    fire({ tone: 'success', title: 'Saved' });
    fire({ tone: 'danger', title: 'Sync failed', description: 'Try again' });
    expect(within(screen.getByRole('status')).getByText('Saved')).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Sync failed')).toBeInTheDocument();
    expect(within(alert).getByText('Try again')).toBeInTheDocument();
  });

  it('portals into the UiProvider root', () => {
    const { container } = setup();
    expect(container.querySelector('.pos-root')).toContainElement(
      screen.getByRole('region', { name: 'Notifications' }),
    );
  });

  it('auto-dismisses after the default duration', () => {
    setup();
    fire({ title: 'Hello' });
    expect(screen.getByText('Hello')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(screen.getByText('Hello')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText('Hello')).not.toBeInTheDocument();
  });

  it('respects durationMs, including 0 for sticky toasts', () => {
    setup();
    fire({ title: 'Quick', durationMs: 1000 });
    fire({ title: 'Sticky', durationMs: 0 });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.queryByText('Quick')).not.toBeInTheDocument();
    expect(screen.getByText('Sticky')).toBeInTheDocument();
  });

  it('pauses on hover and resumes with the remaining time', () => {
    setup();
    fire({ title: 'Hover me', durationMs: 1000 });
    const item = screen.getByText('Hover me').closest('.pos-toast')!;
    act(() => {
      vi.advanceTimersByTime(600);
    });
    fireEvent.mouseEnter(item);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText('Hover me')).toBeInTheDocument();
    fireEvent.mouseLeave(item);
    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(screen.getByText('Hover me')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText('Hover me')).not.toBeInTheDocument();
  });

  it('pauses while focus is inside the toast', () => {
    setup();
    fire({ title: 'Focus me', durationMs: 1000 });
    const dismiss = screen.getByRole('button', { name: 'Dismiss notification' });
    act(() => {
      dismiss.focus();
    });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText('Focus me')).toBeInTheDocument();
    act(() => {
      dismiss.blur();
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText('Focus me')).not.toBeInTheDocument();
  });

  it('dismisses with the labelled dismiss button', () => {
    setup();
    fire({ title: 'Bye', durationMs: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByText('Bye')).not.toBeInTheDocument();
  });

  it('runs an action then dismisses', () => {
    setup();
    const onClick = vi.fn();
    fire({ title: 'Voided', durationMs: 0, action: { label: 'Undo', onClick } });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Voided')).not.toBeInTheDocument();
  });

  it('keeps only the most recent toasts up to maxVisible', () => {
    renderUi(
      <ToastProvider maxVisible={2}>
        <Capture />
      </ToastProvider>,
    );
    fire({ title: 'One', durationMs: 0 });
    fire({ title: 'Two', durationMs: 0 });
    fire({ title: 'Three', durationMs: 0 });
    expect(screen.queryByText('One')).not.toBeInTheDocument();
    expect(screen.getByText('Two')).toBeInTheDocument();
    expect(screen.getByText('Three')).toBeInTheDocument();
  });

  it('dismisses by id and all at once', () => {
    setup();
    let id = '';
    act(() => {
      id = api.toast({ title: 'A', durationMs: 0 });
      api.toast({ title: 'B', durationMs: 0 });
    });
    act(() => api.dismiss(id));
    expect(screen.queryByText('A')).not.toBeInTheDocument();
    act(() => api.dismissAll());
    expect(screen.queryByText('B')).not.toBeInTheDocument();
  });

  it('is keyboard operable', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    setup();
    fire({ title: 'Kb', durationMs: 0 });
    await user.tab();
    expect(screen.getByRole('button', { name: 'Dismiss notification' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.queryByText('Kb')).not.toBeInTheDocument();
  });
});
