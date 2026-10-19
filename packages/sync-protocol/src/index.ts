import type { SyncBatchDto, SyncCommandDto } from '@pos/contracts';

export * from './hlc.js';
export * from './commands.js';
export * from './command-log.js';
export * from './cursor.js';

export const SYNC_PROTOCOL_VERSION = 1 as const;

export type SyncCommand = SyncCommandDto;
export type SyncBatch = SyncBatchDto;

/** Server-side outcome per command (docs/01-system-architecture.md §8.2). */
export type CommandOutcome =
  | { readonly status: 'applied'; readonly serverSeq: number }
  | { readonly status: 'duplicate' }
  | { readonly status: 'rejected'; readonly code: string; readonly detail?: string };

export interface SyncBatchResult {
  readonly clientBatchId: string;
  readonly outcomes: readonly CommandOutcome[];
}

export type FeedStream = 'catalog' | 'config' | 'customers' | 'orders' | 'kitchen';

export interface ChangeRecord {
  readonly seq: number;
  readonly stream: FeedStream;
  readonly entity: string;
  readonly entityId: string;
  readonly op: 'upsert' | 'delete';
  readonly version: number;
  readonly payload: Record<string, unknown>;
}

export interface FeedPage {
  readonly records: readonly ChangeRecord[];
  readonly cursor: number;
  readonly hasMore: boolean;
}
