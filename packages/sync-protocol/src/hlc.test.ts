import { describe, expect, it } from 'vitest';

import { HlcDriftError, HybridLogicalClock, compareHlc, formatHlc, parseHlc } from './hlc.js';

function clockAt(node: string, times: number[]) {
  let i = 0;
  const now = () => times[Math.min(i++, times.length - 1)]!;
  return new HybridLogicalClock(node, now);
}

describe('HybridLogicalClock', () => {
  it('advances with wall time and increments the counter when wall time stalls', () => {
    const clock = clockAt('reg-1', [1000, 1000, 1000, 1001]);
    expect(clock.tick()).toEqual({ wall: 1000, counter: 0, node: 'reg-1' });
    expect(clock.tick()).toEqual({ wall: 1000, counter: 1, node: 'reg-1' });
    expect(clock.tick()).toEqual({ wall: 1000, counter: 2, node: 'reg-1' });
    expect(clock.tick()).toEqual({ wall: 1001, counter: 0, node: 'reg-1' });
  });

  it('never goes backwards when the physical clock does', () => {
    const clock = clockAt('reg-1', [2000, 1500, 1500]);
    const first = clock.tick();
    const second = clock.tick();
    expect(compareHlc(first, second)).toBe(-1);
    expect(second.wall).toBe(2000);
  });

  it('receive() orders after the remote event', () => {
    const clock = clockAt('hub', [1000, 1000]);
    const remote = { wall: 5000, counter: 3, node: 'reg-2' };
    const local = clock.receive(remote);
    expect(compareHlc(remote, local)).toBe(-1);
    expect(local).toEqual({ wall: 5000, counter: 4, node: 'hub' });
    // Same wall from both sides: counter = max + 1.
    const again = clock.receive({ wall: 5000, counter: 9, node: 'reg-3' });
    expect(again).toEqual({ wall: 5000, counter: 10, node: 'hub' });
  });

  it('rejects remote clocks far in the future', () => {
    const clock = new HybridLogicalClock('hub', () => 1000, 1000);
    expect(() => clock.receive({ wall: 5000, counter: 0, node: 'bad' })).toThrow(HlcDriftError);
  });

  it('serialises so string order matches causal order', () => {
    const a = formatHlc({ wall: 999, counter: 5, node: 'a' });
    const b = formatHlc({ wall: 1000, counter: 0, node: 'a' });
    expect(a < b).toBe(true);
    expect(parseHlc(b)).toEqual({ wall: 1000, counter: 0, node: 'a' });
    expect(() => parseHlc('nope')).toThrow(TypeError);
  });
});
