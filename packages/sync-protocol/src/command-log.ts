/**
 * Device-side command log (docs/01-system-architecture.md §8.1 group 2, §8.2, §8.4).
 *
 *   append()            write locally, durable before the promise resolves → UI may acknowledge
 *   nextBatch()         take pending commands in device order and mark them in flight
 *   applyBatchResult()  record per-command outcomes; `duplicate` counts as acked (idempotent replay)
 *   recover()           after a crash, anything in flight goes back to pending: the server
 *                       deduplicates on clientCommandId, so resending is harmless
 */
import type { SyncBatchResult } from './index.js';
import { formatHlc, parseHlc, type HlcTimestamp, type HybridLogicalClock } from './hlc.js';
import {
  type CommandLogStore,
  type CommandStatus,
  type LocalCommand,
  type OutgoingBatch,
  toWireCommand,
} from './commands.js';

export const MAX_BATCH_SIZE = 500;

export type CommandLogEvent =
  | { readonly kind: 'appended'; readonly command: LocalCommand }
  | { readonly kind: 'batch_taken'; readonly batchId: string; readonly count: number }
  | { readonly kind: 'batch_applied'; readonly batchId: string; readonly result: SyncBatchResult }
  | { readonly kind: 'batch_failed'; readonly batchId: string }
  | { readonly kind: 'recovered'; readonly count: number };

export type CommandLogListener = (event: CommandLogEvent) => void;

export interface CommandLogOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly maxBatchSize?: number;
}

function defaultId(): string {
  // The package builds without DOM or Node typings, so describe just the one global it needs.
  return (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();
}

export class CommandLog {
  private nextSeq = 1;
  private initialised = false;
  private readonly listeners = new Set<CommandLogListener>();
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly maxBatchSize: number;
  /** Serialises appends so two concurrent calls never share a seq. */
  private appendChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: CommandLogStore,
    private readonly clock: HybridLogicalClock,
    options: CommandLogOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? defaultId;
    this.maxBatchSize = Math.min(options.maxBatchSize ?? MAX_BATCH_SIZE, MAX_BATCH_SIZE);
  }

  /**
   * Load the sequence from the store and move any in-flight command back to pending. Call once at
   * start-up; this is the crash-recovery step (docs/01 §8.4).
   */
  async init(): Promise<{ recovered: number }> {
    this.nextSeq = (await this.store.maxSeq()) + 1;
    const inFlight = await this.store.list(['in_flight']);
    if (inFlight.length > 0) {
      await this.store.update(
        inFlight.map((c) => c.clientCommandId),
        { status: 'pending' },
      );
      // Re-seat the clock after the newest persisted timestamp so new commands sort after old ones.
      const newest = inFlight[inFlight.length - 1]!;
      this.clock.receive(parseHlc(newest.hlc));
    }
    this.initialised = true;
    this.emit({ kind: 'recovered', count: inFlight.length });
    return { recovered: inFlight.length };
  }

  subscribe(listener: CommandLogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Durable append. Resolves only after the store has persisted the command. */
  append<P extends Record<string, unknown>>(type: string, payload: P): Promise<LocalCommand<P>> {
    if (!this.initialised)
      return Promise.reject(new Error('CommandLog.init() must complete before use'));
    const run = async (): Promise<LocalCommand<P>> => {
      const command: LocalCommand<P> = {
        clientCommandId: this.newId(),
        seq: this.nextSeq,
        type,
        payload,
        hlc: formatHlc(this.clock.tick()),
        clientTime: this.now().toISOString(),
        status: 'pending',
        batchId: null,
        serverResult: null,
      };
      await this.store.append(command);
      this.nextSeq += 1;
      this.emit({ kind: 'appended', command });
      return command;
    };
    const next = this.appendChain.then(run, run);
    this.appendChain = next.catch(() => undefined);
    return next;
  }

  /** Merge a timestamp seen from another node (feed records, hub messages). */
  observe(remote: HlcTimestamp): void {
    this.clock.receive(remote);
  }

  pendingCount(): Promise<number> {
    return this.store.count(['pending', 'in_flight']);
  }

  rejected(): Promise<LocalCommand[]> {
    return this.store.list(['rejected']);
  }

  /**
   * Take the next batch of pending commands in device order. Returns null when nothing is pending.
   * The commands are marked in flight before the batch is returned, so a crash after this point is
   * recovered by `init()`.
   */
  async nextBatch(deviceId: string): Promise<OutgoingBatch | null> {
    this.assertInitialised();
    const pending = await this.store.list(['pending'], this.maxBatchSize);
    if (pending.length === 0) return null;
    const batchId = this.newId();
    await this.store.update(
      pending.map((c) => c.clientCommandId),
      { status: 'in_flight', batchId },
    );
    this.emit({ kind: 'batch_taken', batchId, count: pending.length });
    return { deviceId, clientBatchId: batchId, commands: pending.map(toWireCommand) };
  }

  /**
   * Record the server's outcomes for a batch. Outcomes are positional (the server processes the
   * batch in order). `applied` and `duplicate` both mean the fact is on the server.
   */
  async applyBatchResult(batch: OutgoingBatch, result: SyncBatchResult): Promise<void> {
    if (result.clientBatchId !== batch.clientBatchId)
      throw new Error(
        `Batch result ${result.clientBatchId} does not match batch ${batch.clientBatchId}`,
      );
    const acked: string[] = [];
    const unanswered: string[] = [];
    for (const [index, command] of batch.commands.entries()) {
      const outcome = result.outcomes[index];
      if (!outcome) {
        unanswered.push(command.clientCommandId);
        continue;
      }
      if (outcome.status === 'rejected') {
        await this.store.update([command.clientCommandId], {
          status: 'rejected',
          serverResult: outcome,
        });
      } else {
        await this.store.update([command.clientCommandId], {
          status: 'acked',
          serverResult: outcome,
        });
        acked.push(command.clientCommandId);
      }
    }
    if (unanswered.length > 0) await this.store.update(unanswered, { status: 'pending' });
    this.emit({ kind: 'batch_applied', batchId: batch.clientBatchId, result });
  }

  /** The upload failed before any answer: everything in the batch is pending again. */
  async failBatch(batch: OutgoingBatch): Promise<void> {
    await this.store.update(
      batch.commands.map((c) => c.clientCommandId),
      { status: 'pending' },
    );
    this.emit({ kind: 'batch_failed', batchId: batch.clientBatchId });
  }

  list(statuses: readonly CommandStatus[] = ['pending', 'in_flight', 'acked', 'rejected']) {
    return this.store.list(statuses);
  }

  private assertInitialised(): void {
    if (!this.initialised) throw new Error('CommandLog.init() must complete before use');
  }

  private emit(event: CommandLogEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** Transport the uploader talks to: `POST /v1/sync/batches` in production, a fake in tests. */
export type BatchTransport = (batch: OutgoingBatch) => Promise<SyncBatchResult>;

/**
 * Drains the log one batch at a time. A transport failure puts the batch back to pending and
 * stops the drain; the next call resumes. Never runs two drains at once.
 */
export class SyncUploader {
  private draining: Promise<number> | null = null;

  constructor(
    private readonly log: CommandLog,
    private readonly deviceId: string,
    private readonly transport: BatchTransport,
  ) {}

  /** Upload until nothing is pending or a transport error occurs. Resolves with the number of batches sent. */
  drain(): Promise<number> {
    if (this.draining) return this.draining;
    this.draining = this.run().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async run(): Promise<number> {
    let batches = 0;
    for (;;) {
      const batch = await this.log.nextBatch(this.deviceId);
      if (!batch) return batches;
      let result;
      try {
        result = await this.transport(batch);
      } catch (error) {
        await this.log.failBatch(batch);
        throw error;
      }
      await this.log.applyBatchResult(batch, result);
      batches += 1;
    }
  }
}
