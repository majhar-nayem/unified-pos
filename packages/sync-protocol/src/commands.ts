/**
 * Command-log types for the device side of the sync protocol
 * (docs/01-system-architecture.md §8.1 group 2 and §8.2).
 *
 * A command is an intent recorded locally *before* the UI acknowledges it. The server re-executes
 * it through the normal application service; the device only keeps the outcome.
 */
import type { SyncBatchDto, SyncCommandDto } from '@pos/contracts';

import type { CommandOutcome } from './index.js';

/**
 * Lifecycle on the device:
 *   pending   → written locally, not yet in a batch
 *   in_flight → part of a batch that has been (or is being) uploaded; the answer is unknown
 *   acked     → server applied it (or already had it: `duplicate`)
 *   rejected  → server refused it; surfaced to the manager queue, the local fact still stands
 */
export type CommandStatus = 'pending' | 'in_flight' | 'acked' | 'rejected';

export interface LocalCommand<P extends Record<string, unknown> = Record<string, unknown>> {
  readonly clientCommandId: string;
  /** Device-local monotonic sequence: the order the UI produced the commands in. */
  readonly seq: number;
  readonly type: string;
  readonly payload: P;
  /** Formatted hybrid logical clock (see `formatHlc`): cross-device order of facts. */
  readonly hlc: string;
  /** Wall clock on the device when the command was created (ISO 8601). */
  readonly clientTime: string;
  readonly status: CommandStatus;
  /** Batch this command was last sent in, if any. */
  readonly batchId: string | null;
  readonly serverResult: CommandOutcome | null;
}

/** The wire shape of a local command (what goes into `SyncBatchDto.commands`). */
export function toWireCommand(command: LocalCommand): SyncCommandDto {
  return {
    clientCommandId: command.clientCommandId,
    type: command.type,
    payload: command.payload,
    hlc: command.hlc,
    clientTime: command.clientTime,
  };
}

export type OutgoingBatch = SyncBatchDto;

/**
 * Persistence port for the command log. The POS implements it on SQLite; tests use the in-memory
 * store. Every method must be durable before it resolves: `append` is the write that happens
 * before the UI acknowledges the action (docs/01 §8.4 "App crash mid-checkout").
 */
export interface CommandLogStore {
  append(command: LocalCommand): Promise<void>;
  get(clientCommandId: string): Promise<LocalCommand | null>;
  /** Commands in `seq` order whose status is one of `statuses`. */
  list(statuses: readonly CommandStatus[], limit?: number): Promise<LocalCommand[]>;
  /** Patch status/batch/result for the given ids (all or nothing where the store can). */
  update(
    clientCommandIds: readonly string[],
    patch: Partial<Pick<LocalCommand, 'status' | 'batchId' | 'serverResult'>>,
  ): Promise<void>;
  /** Highest `seq` ever appended, or 0 when the log is empty. */
  maxSeq(): Promise<number>;
  count(statuses: readonly CommandStatus[]): Promise<number>;
}

/** In-memory store for tests and the browser dev fallback. Mutations are copied so callers cannot alias rows. */
export class MemoryCommandLogStore implements CommandLogStore {
  private readonly rows = new Map<string, LocalCommand>();

  async append(command: LocalCommand): Promise<void> {
    if (this.rows.has(command.clientCommandId))
      throw new Error(`Duplicate clientCommandId ${command.clientCommandId}`);
    this.rows.set(command.clientCommandId, { ...command });
  }

  async get(clientCommandId: string): Promise<LocalCommand | null> {
    const row = this.rows.get(clientCommandId);
    return row ? { ...row } : null;
  }

  async list(statuses: readonly CommandStatus[], limit = Number.POSITIVE_INFINITY) {
    return [...this.rows.values()]
      .filter((r) => statuses.includes(r.status))
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async update(
    ids: readonly string[],
    patch: Partial<Pick<LocalCommand, 'status' | 'batchId' | 'serverResult'>>,
  ): Promise<void> {
    for (const id of ids) {
      const row = this.rows.get(id);
      if (row) this.rows.set(id, { ...row, ...patch });
    }
  }

  async maxSeq(): Promise<number> {
    let max = 0;
    for (const r of this.rows.values()) if (r.seq > max) max = r.seq;
    return max;
  }

  async count(statuses: readonly CommandStatus[]): Promise<number> {
    let n = 0;
    for (const r of this.rows.values()) if (statuses.includes(r.status)) n += 1;
    return n;
  }

  /** Test helper: a snapshot of every row (used to simulate a crash + restart on the same disk). */
  snapshot(): LocalCommand[] {
    return [...this.rows.values()].sort((a, b) => a.seq - b.seq).map((r) => ({ ...r }));
  }
}
