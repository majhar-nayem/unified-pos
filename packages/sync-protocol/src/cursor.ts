/**
 * Download cursors (docs/01-system-architecture.md §8.2 DOWNLOAD): one monotonic sequence per feed
 * stream. Pull is the truth; a WebSocket hint only triggers a pull.
 */
import type { FeedPage, FeedStream } from './index.js';

export interface CursorStore {
  get(stream: FeedStream): Promise<number | null>;
  set(stream: FeedStream, cursor: number): Promise<void>;
}

export class MemoryCursorStore implements CursorStore {
  private readonly cursors = new Map<FeedStream, number>();
  async get(stream: FeedStream): Promise<number | null> {
    return this.cursors.get(stream) ?? null;
  }
  async set(stream: FeedStream, cursor: number): Promise<void> {
    this.cursors.set(stream, cursor);
  }
}

export class CursorRegressionError extends Error {
  constructor(
    public readonly stream: FeedStream,
    public readonly current: number,
    public readonly offered: number,
  ) {
    super(`Cursor for ${stream} would move backwards (${current} → ${offered})`);
    this.name = 'CursorRegressionError';
  }
}

/** Cursor bookkeeping with a never-backwards guard; a snapshot bootstrap resets explicitly. */
export class FeedCursors {
  constructor(private readonly store: CursorStore) {}

  /** The cursor to send on the next pull (0 = from the beginning / needs a snapshot). */
  async next(stream: FeedStream): Promise<number> {
    return (await this.store.get(stream)) ?? 0;
  }

  /** Advance after a page has been applied locally. Rejects regressions; ignores equal cursors. */
  async advance(stream: FeedStream, page: Pick<FeedPage, 'cursor' | 'records'>): Promise<number> {
    const current = (await this.store.get(stream)) ?? 0;
    if (page.cursor < current) throw new CursorRegressionError(stream, current, page.cursor);
    const highestSeq = page.records.reduce((max, r) => Math.max(max, r.seq), page.cursor);
    if (highestSeq > page.cursor)
      throw new Error(`Feed page for ${stream} contains seq ${highestSeq} beyond its cursor`);
    if (page.cursor > current) await this.store.set(stream, page.cursor);
    return page.cursor;
  }

  /** After loading a snapshot taken at `cursor`, the feed continues from there. */
  async reset(stream: FeedStream, cursor: number): Promise<void> {
    await this.store.set(stream, cursor);
  }
}

/** Build the query string for `GET /v1/sync/feed`. */
export function feedQuery(streams: readonly FeedStream[], cursor: number): string {
  return `streams=${encodeURIComponent(streams.join(','))}&cursor=${cursor}`;
}
