/**
 * Hybrid logical clock (Kulkarni et al.) used to order facts across devices
 * (docs/01-system-architecture.md §8.2: "across devices, order of facts is by hybrid logical clock").
 *
 * Timestamp = (wallMillis, counter, nodeId). Serialised as "<wall>:<counter>:<node>" with fixed-width
 * numeric fields so lexicographic order equals causal order.
 */
export interface HlcTimestamp {
  readonly wall: number;
  readonly counter: number;
  readonly node: string;
}

const WALL_WIDTH = 15;
const COUNTER_WIDTH = 6;
const MAX_COUNTER = 10 ** COUNTER_WIDTH - 1;
/** Reject remote clocks more than this far ahead of ours (likely misconfigured device). */
export const DEFAULT_MAX_DRIFT_MS = 60 * 60 * 1000;

export class HlcDriftError extends Error {
  constructor(public readonly driftMs: number) {
    super(`Remote HLC is ${driftMs} ms ahead of the local clock; refusing to advance`);
    this.name = 'HlcDriftError';
  }
}

export class HybridLogicalClock {
  private wall = 0;
  private counter = 0;

  constructor(
    public readonly node: string,
    private readonly now: () => number = () => Date.now(),
    private readonly maxDriftMs: number = DEFAULT_MAX_DRIFT_MS,
  ) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(node)) throw new TypeError(`Invalid HLC node id "${node}"`);
  }

  /** Timestamp for a local event (send or local write). */
  tick(): HlcTimestamp {
    const physical = this.now();
    if (physical > this.wall) {
      this.wall = physical;
      this.counter = 0;
    } else {
      this.counter += 1;
      if (this.counter > MAX_COUNTER) throw new RangeError('HLC counter overflow');
    }
    return this.snapshot();
  }

  /** Merge a timestamp received from another node, then produce the local timestamp for the receive event. */
  receive(remote: HlcTimestamp): HlcTimestamp {
    const physical = this.now();
    if (remote.wall - physical > this.maxDriftMs) throw new HlcDriftError(remote.wall - physical);

    if (physical > this.wall && physical > remote.wall) {
      this.wall = physical;
      this.counter = 0;
    } else if (this.wall === remote.wall) {
      this.counter = Math.max(this.counter, remote.counter) + 1;
    } else if (this.wall > remote.wall) {
      this.counter += 1;
    } else {
      this.wall = remote.wall;
      this.counter = remote.counter + 1;
    }
    if (this.counter > MAX_COUNTER) throw new RangeError('HLC counter overflow');
    return this.snapshot();
  }

  current(): HlcTimestamp {
    return this.snapshot();
  }

  private snapshot(): HlcTimestamp {
    return { wall: this.wall, counter: this.counter, node: this.node };
  }
}

export function compareHlc(a: HlcTimestamp, b: HlcTimestamp): -1 | 0 | 1 {
  if (a.wall !== b.wall) return a.wall < b.wall ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.node !== b.node) return a.node < b.node ? -1 : 1;
  return 0;
}

export function formatHlc(ts: HlcTimestamp): string {
  return `${String(ts.wall).padStart(WALL_WIDTH, '0')}:${String(ts.counter).padStart(COUNTER_WIDTH, '0')}:${ts.node}`;
}

export function parseHlc(text: string): HlcTimestamp {
  const match = /^(\d{1,15}):(\d{1,6}):([A-Za-z0-9_.-]{1,64})$/.exec(text);
  if (!match) throw new TypeError(`Invalid HLC string "${text}"`);
  return { wall: Number(match[1]), counter: Number(match[2]), node: match[3]! };
}
