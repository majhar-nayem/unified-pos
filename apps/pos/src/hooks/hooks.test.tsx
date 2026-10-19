import { CommandLog, HybridLogicalClock, MemoryCommandLogStore } from '@pos/sync-protocol';
import { MockScanner } from '@pos/hardware';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectivityMonitor, useConnectivity } from './connectivity.js';
import { classifyViewport, useDeviceClass } from './useDeviceClass.js';
import { useScannerCapture } from './useScannerCapture.js';
import { useSyncQueue } from './useSyncQueue.js';

afterEach(cleanup);

// --- useScannerCapture -------------------------------------------------------------------------

/** Dispatch a keydown on `target` with an explicit event time, like a device would deliver it. */
function key(target: EventTarget, k: string, at: number): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'timeStamp', { value: at });
  target.dispatchEvent(event);
  return event;
}

function burst(
  target: EventTarget,
  code: string,
  start: number,
  gap: number,
  terminator = 'Enter',
) {
  const events: KeyboardEvent[] = [];
  let t = start;
  for (const ch of code) {
    events.push(key(target, ch, t));
    t += gap;
  }
  events.push(key(target, terminator, t));
  return events;
}

function Harness({
  onScan,
  enabled = true,
  scanners,
}: {
  onScan: (code: string) => void;
  enabled?: boolean;
  scanners?: MockScanner[];
}) {
  useScannerCapture((e) => onScan(e.code), { enabled, ...(scanners ? { scanners } : {}) });
  return (
    <div>
      <button>Pay</button>
      <input aria-label="plain" />
      <input aria-label="scan field" data-scan-target />
    </div>
  );
}

describe('useScannerCapture', () => {
  it('captures a fast burst ended by Enter with no focus anywhere', () => {
    const onScan = vi.fn();
    render(<Harness onScan={onScan} />);
    burst(document.body, '9300675024235', 1000, 8);
    expect(onScan).toHaveBeenCalledExactlyOnceWith('9300675024235');
  });

  it('swallows the characters and the Enter so a focused button is never pressed', () => {
    const onScan = vi.fn();
    render(<Harness onScan={onScan} />);
    const button = screen.getByRole('button', { name: 'Pay' });
    const onClick = vi.fn();
    button.addEventListener('click', onClick);
    button.focus();
    const events = burst(button, '12345678', 1000, 5);
    expect(events.every((e) => e.defaultPrevented)).toBe(true);
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it('ignores slow typing', () => {
    const onScan = vi.fn();
    render(<Harness onScan={onScan} />);
    burst(document.body, '12345678', 1000, 250);
    expect(onScan).not.toHaveBeenCalled();
  });

  it('leaves text fields alone unless they opt in with data-scan-target', () => {
    const onScan = vi.fn();
    render(<Harness onScan={onScan} />);
    const plain = screen.getByLabelText('plain');
    const events = burst(plain, '12345678', 1000, 5);
    expect(onScan).not.toHaveBeenCalled();
    expect(events.some((e) => e.defaultPrevented)).toBe(false);
    burst(screen.getByLabelText('scan field'), '87654321', 5000, 5);
    expect(onScan).toHaveBeenCalledExactlyOnceWith('87654321');
  });

  it('does not react to shortcuts with modifier keys', () => {
    const onScan = vi.fn();
    render(<Harness onScan={onScan} />);
    const event = new KeyboardEvent('keydown', {
      key: 'a',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('delivers scans from native scanners through the same handler', () => {
    const onScan = vi.fn();
    const mock = new MockScanner();
    render(<Harness onScan={onScan} scanners={[mock]} />);
    mock.emit('555');
    expect(onScan).toHaveBeenCalledExactlyOnceWith('555');
  });

  it('does nothing when disabled (PIN screen) and stops after unmount', () => {
    const onScan = vi.fn();
    const { rerender, unmount } = render(<Harness onScan={onScan} enabled={false} />);
    burst(document.body, '12345678', 1000, 5);
    expect(onScan).not.toHaveBeenCalled();
    rerender(<Harness onScan={onScan} enabled />);
    burst(document.body, '12345678', 2000, 5);
    expect(onScan).toHaveBeenCalledTimes(1);
    unmount();
    burst(document.body, '12345678', 3000, 5);
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it('always calls the latest handler without re-subscribing', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Harness onScan={first} />);
    rerender(<Harness onScan={second} />);
    burst(document.body, '12345678', 1000, 5);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

// --- device class -----------------------------------------------------------------------------

describe('device classes', () => {
  it.each([
    [1920, 1080, 'terminal'],
    [1366, 768, 'terminal'],
    [1280, 800, 'tablet-landscape'],
    [800, 1280, 'tablet-portrait'],
    [1024, 768, 'tablet-landscape'],
    [768, 1024, 'handheld'],
    [390, 844, 'handheld'],
  ] as const)('%ix%i is %s', (w, h, expected) => {
    expect(classifyViewport(w, h)).toBe(expected);
  });

  it('follows resize and orientation changes', () => {
    const set = (w: number, h: number) => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
      window.dispatchEvent(new Event('resize'));
    };
    set(1280, 800);
    const { result } = renderHook(() => useDeviceClass());
    expect(result.current).toBe('tablet-landscape');
    act(() => set(800, 1280));
    expect(result.current).toBe('tablet-portrait');
    act(() => set(390, 844));
    expect(result.current).toBe('handheld');
  });
});

// --- connectivity -----------------------------------------------------------------------------

describe('ConnectivityMonitor', () => {
  const make = (probe: () => Promise<boolean>) => {
    const events = new EventTarget();
    let time = 1_000;
    const intervals: Array<() => void> = [];
    const monitor = new ConnectivityMonitor(probe, {
      now: () => time,
      events,
      setInterval: (fn) => intervals.push(fn),
      clearInterval: () => intervals.pop(),
    });
    return {
      monitor,
      events,
      tick: async () => {
        time += 15_000;
        intervals[0]?.();
        await Promise.resolve();
        await Promise.resolve();
      },
      advance: (ms: number) => (time += ms),
    };
  };

  it('starts unknown, then follows the probe', async () => {
    let up = true;
    const { monitor, tick } = make(async () => up);
    expect(monitor.getState().status).toBe('unknown');
    monitor.start();
    await waitFor(() => expect(monitor.getState().status).toBe('online'));
    up = false;
    await tick();
    await waitFor(() => expect(monitor.getState().status).toBe('offline'));
    monitor.stop();
  });

  it('keeps `since` unchanged while the status holds and moves it on a change', async () => {
    const { monitor, advance } = make(async () => true);
    monitor.report(true);
    const since = monitor.getState().since;
    advance(5_000);
    monitor.report(true);
    expect(monitor.getState().since).toBe(since);
    monitor.report(false);
    expect(monitor.getState().since).toBe(since + 5_000);
  });

  it('the browser offline event flips to offline at once, online event re-probes', async () => {
    const { monitor, events } = make(async () => true);
    monitor.start();
    await waitFor(() => expect(monitor.getState().status).toBe('online'));
    events.dispatchEvent(new Event('offline'));
    expect(monitor.getState().status).toBe('offline');
    events.dispatchEvent(new Event('online'));
    await waitFor(() => expect(monitor.getState().status).toBe('online'));
    monitor.stop();
  });

  it('a throwing probe counts as offline', async () => {
    const { monitor } = make(async () => {
      throw new Error('boom');
    });
    expect(await monitor.check()).toBe('offline');
  });

  it('useConnectivity re-renders on change', async () => {
    const { monitor } = make(async () => true);
    const { result } = renderHook(() => useConnectivity(monitor));
    expect(result.current.status).toBe('unknown');
    act(() => monitor.report(false));
    expect(result.current.status).toBe('offline');
  });
});

// --- sync queue badge -------------------------------------------------------------------------

describe('useSyncQueue', () => {
  it('counts unsynced and rejected commands as the log changes', async () => {
    const log = new CommandLog(new MemoryCommandLogStore(), new HybridLogicalClock('r1'));
    await log.init();
    const { result } = renderHook(() => useSyncQueue(log));
    expect(result.current).toEqual({ unsynced: 0, rejected: 0 });
    await act(async () => {
      await log.append('cart.line.add', {});
      await log.append('order.void', {});
    });
    await waitFor(() => expect(result.current.unsynced).toBe(2));
    await act(async () => {
      const batch = (await log.nextBatch('d'))!;
      await log.applyBatchResult(batch, {
        clientBatchId: batch.clientBatchId,
        outcomes: [
          { status: 'applied', serverSeq: 1 },
          { status: 'rejected', code: 'LIMIT_EXCEEDED' },
        ],
      });
    });
    await waitFor(() => expect(result.current).toEqual({ unsynced: 0, rejected: 1 }));
  });
});
