/**
 * Replica loader: pulls the change feed into the local replicas (docs/01 §8.2 DOWNLOAD).
 *
 *   GET /v1/sync/feed?streams=catalog,config&cursor=<seq>  → { records, cursor, hasMore }
 *
 * Status of the endpoint: F1 does not ship `/v1/sync/*` (it lands with M1 server-side sync, Wave 2).
 * When the server answers 404, the loader falls back to a **documented stub**: the demo catalogue in
 * `catalog/placeholder.ts` is applied once and the result reports `source: 'stub'`, so the UI can
 * say "demo data" instead of pretending the replica is live.
 */
import {
  FeedCursors,
  feedQuery,
  type ChangeRecord,
  type FeedPage,
  type FeedStream,
} from '@pos/sync-protocol';

import { ApiError, NetworkError, type ApiClient } from '../api/client.js';
import { STUB_CATALOG_RECORDS } from '../catalog/placeholder.js';
import type { LocalStore } from './stores.js';

export type ReplicaSyncResult =
  | {
      readonly source: 'feed';
      readonly applied: number;
      readonly cursors: Partial<Record<FeedStream, number>>;
    }
  | { readonly source: 'stub'; readonly applied: number }
  | { readonly source: 'offline'; readonly applied: 0; readonly message: string };

export const DEFAULT_STREAMS: readonly FeedStream[] = ['catalog', 'config'];
const MAX_PAGES = 200;

function isChangeRecord(value: unknown): value is ChangeRecord {
  const r = value as Partial<ChangeRecord> | null;
  return (
    !!r &&
    typeof r.seq === 'number' &&
    typeof r.stream === 'string' &&
    typeof r.entity === 'string' &&
    typeof r.entityId === 'string' &&
    (r.op === 'upsert' || r.op === 'delete') &&
    typeof r.version === 'number' &&
    typeof r.payload === 'object' &&
    r.payload !== null
  );
}

export function parseFeedPage(value: unknown): FeedPage {
  const page = value as Partial<FeedPage> | null;
  if (
    !page ||
    !Array.isArray(page.records) ||
    typeof page.cursor !== 'number' ||
    !page.records.every(isChangeRecord)
  )
    throw new Error('Malformed change-feed page');
  return { records: page.records, cursor: page.cursor, hasMore: page.hasMore === true };
}

export class ReplicaLoader {
  private readonly cursors: FeedCursors;
  constructor(
    private readonly store: LocalStore,
    private readonly client: ApiClient,
    private readonly streams: readonly FeedStream[] = DEFAULT_STREAMS,
  ) {
    this.cursors = new FeedCursors(store.cursors);
  }

  async sync(token: string): Promise<ReplicaSyncResult> {
    let applied = 0;
    const reached: Partial<Record<FeedStream, number>> = {};
    try {
      for (const stream of this.streams) {
        for (let pages = 0; pages < MAX_PAGES; pages++) {
          const cursor = await this.cursors.next(stream);
          const raw = await this.client.request('GET', '/sync/feed', {
            token,
            query: Object.fromEntries(new URLSearchParams(feedQuery([stream], cursor))),
          });
          const page = parseFeedPage(raw);
          // Apply first, advance the cursor second: a crash in between re-applies the page, which is idempotent.
          await this.store.replicas.apply(page.records);
          await this.cursors.advance(stream, page);
          applied += page.records.length;
          reached[stream] = page.cursor;
          if (!page.hasMore) break;
        }
      }
      return { source: 'feed', applied, cursors: reached };
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 501))
        return this.loadStub();
      if (error instanceof NetworkError)
        return {
          source: 'offline',
          applied: 0,
          message: 'Offline: using the last replica on this device.',
        };
      throw error;
    }
  }

  private async loadStub(): Promise<ReplicaSyncResult> {
    const existing = await this.store.replicas.count('catalog', 'variant');
    if (existing > 0) return { source: 'stub', applied: 0 };
    await this.store.replicas.apply(STUB_CATALOG_RECORDS);
    return { source: 'stub', applied: STUB_CATALOG_RECORDS.length };
  }
}
