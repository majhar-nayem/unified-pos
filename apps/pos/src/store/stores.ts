/** Store interfaces used by the app, with SQLite and in-memory implementations. */
import {
  type ChangeRecord,
  type CommandLogStore,
  type CommandOutcome,
  type CommandStatus,
  type CursorStore,
  type FeedStream,
  type LocalCommand,
  MemoryCommandLogStore,
  MemoryCursorStore,
} from '@pos/sync-protocol';

import { type SqlDatabase, type SqlValue, placeholders } from './sql.js';

// --- replicas ---------------------------------------------------------------------------------

export interface ReplicaRecord {
  readonly stream: FeedStream;
  readonly entity: string;
  readonly entityId: string;
  readonly version: number;
  readonly seq: number;
  readonly payload: Record<string, unknown>;
}

export interface StaffEntry {
  readonly userId: string;
  readonly displayName: string;
  readonly lastUsedAt: string | null;
}

export interface ReplicaStore {
  /** Apply feed records. Idempotent: an older or equal version never overwrites a newer one. */
  apply(records: readonly ChangeRecord[]): Promise<void>;
  get(stream: FeedStream, entity: string, entityId: string): Promise<ReplicaRecord | null>;
  list(stream: FeedStream, entity: string): Promise<ReplicaRecord[]>;
  /** Scan lookup: barcode → the variant record, from the barcode index. */
  findByBarcode(code: string): Promise<ReplicaRecord | null>;
  count(stream: FeedStream, entity: string): Promise<number>;
  staff(): Promise<StaffEntry[]>;
  rememberStaff(entry: { userId: string; displayName: string }, at: string): Promise<void>;
}

/** Barcodes live inside variant payloads: `{ barcodes: [{ code }] }` (VariantWithBarcodesDto). */
export function barcodesOf(record: Pick<ChangeRecord, 'entity' | 'payload'>): string[] {
  if (record.entity !== 'variant') return [];
  const raw = record.payload.barcodes;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((b) => (typeof b === 'string' ? b : (b as { code?: unknown } | null)?.code))
    .filter((c): c is string => typeof c === 'string' && c.length > 0);
}

export class SqliteReplicaStore implements ReplicaStore {
  constructor(private readonly db: SqlDatabase) {}

  async apply(records: readonly ChangeRecord[]): Promise<void> {
    for (const r of records) {
      const existing = await this.db.select<{ version: number }>(
        'SELECT version FROM replica_records WHERE stream = $1 AND entity = $2 AND entity_id = $3',
        [r.stream, r.entity, r.entityId],
      );
      const current = existing[0]?.version;
      if (r.op === 'delete') {
        if (current !== undefined && current > r.version) continue;
        await this.db.execute(
          'DELETE FROM replica_records WHERE stream = $1 AND entity = $2 AND entity_id = $3',
          [r.stream, r.entity, r.entityId],
        );
        if (r.entity === 'variant')
          await this.db.execute('DELETE FROM replica_barcodes WHERE variant_id = $1', [r.entityId]);
        continue;
      }
      if (current !== undefined && current >= r.version) continue;
      await this.db.execute(
        `INSERT INTO replica_records (stream, entity, entity_id, version, seq, payload)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT(stream, entity, entity_id)
         DO UPDATE SET version = excluded.version, seq = excluded.seq, payload = excluded.payload`,
        [r.stream, r.entity, r.entityId, r.version, r.seq, JSON.stringify(r.payload)],
      );
      if (r.entity === 'variant') {
        await this.db.execute('DELETE FROM replica_barcodes WHERE variant_id = $1', [r.entityId]);
        for (const code of barcodesOf(r))
          await this.db.execute(
            `INSERT INTO replica_barcodes (code, variant_id) VALUES ($1, $2)
             ON CONFLICT(code) DO UPDATE SET variant_id = excluded.variant_id`,
            [code, r.entityId],
          );
      }
    }
  }

  private toRecord(row: Record<string, unknown>): ReplicaRecord {
    return {
      stream: row.stream as FeedStream,
      entity: row.entity as string,
      entityId: row.entity_id as string,
      version: Number(row.version),
      seq: Number(row.seq),
      payload: JSON.parse(row.payload as string) as Record<string, unknown>,
    };
  }

  async get(stream: FeedStream, entity: string, entityId: string) {
    const rows = await this.db.select(
      'SELECT * FROM replica_records WHERE stream = $1 AND entity = $2 AND entity_id = $3',
      [stream, entity, entityId],
    );
    return rows[0] ? this.toRecord(rows[0]) : null;
  }

  async list(stream: FeedStream, entity: string) {
    const rows = await this.db.select(
      'SELECT * FROM replica_records WHERE stream = $1 AND entity = $2 ORDER BY seq',
      [stream, entity],
    );
    return rows.map((r) => this.toRecord(r));
  }

  async findByBarcode(code: string) {
    const rows = await this.db.select(
      `SELECT r.* FROM replica_barcodes b
         JOIN replica_records r ON r.entity_id = b.variant_id AND r.entity = 'variant'
        WHERE b.code = $1`,
      [code],
    );
    return rows[0] ? this.toRecord(rows[0]) : null;
  }

  async count(stream: FeedStream, entity: string) {
    const rows = await this.db.select<{ n: number }>(
      'SELECT COUNT(*) AS n FROM replica_records WHERE stream = $1 AND entity = $2',
      [stream, entity],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async staff() {
    const rows = await this.db.select(
      'SELECT user_id, display_name, last_used_at FROM replica_staff ORDER BY last_used_at DESC, display_name',
    );
    return rows.map((r) => ({
      userId: r.user_id as string,
      displayName: r.display_name as string,
      lastUsedAt: (r.last_used_at as string | null) ?? null,
    }));
  }

  async rememberStaff(entry: { userId: string; displayName: string }, at: string) {
    await this.db.execute(
      `INSERT INTO replica_staff (user_id, display_name, last_used_at) VALUES ($1, $2, $3)
       ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, last_used_at = excluded.last_used_at`,
      [entry.userId, entry.displayName, at],
    );
  }
}

export class MemoryReplicaStore implements ReplicaStore {
  private readonly rows = new Map<string, ReplicaRecord>();
  private readonly staffRows = new Map<string, StaffEntry>();
  private key = (s: string, e: string, id: string) => `${s}\u0000${e}\u0000${id}`;

  async apply(records: readonly ChangeRecord[]) {
    for (const r of records) {
      const k = this.key(r.stream, r.entity, r.entityId);
      const current = this.rows.get(k);
      if (r.op === 'delete') {
        if (!current || current.version <= r.version) this.rows.delete(k);
        continue;
      }
      if (current && current.version >= r.version) continue;
      this.rows.set(k, {
        stream: r.stream,
        entity: r.entity,
        entityId: r.entityId,
        version: r.version,
        seq: r.seq,
        payload: r.payload,
      });
    }
  }
  async get(stream: FeedStream, entity: string, id: string) {
    return this.rows.get(this.key(stream, entity, id)) ?? null;
  }
  async list(stream: FeedStream, entity: string) {
    return [...this.rows.values()]
      .filter((r) => r.stream === stream && r.entity === entity)
      .sort((a, b) => a.seq - b.seq);
  }
  async findByBarcode(code: string) {
    for (const r of this.rows.values())
      if (r.entity === 'variant' && barcodesOf(r).includes(code)) return r;
    return null;
  }
  async count(stream: FeedStream, entity: string) {
    return (await this.list(stream, entity)).length;
  }
  async staff() {
    return [...this.staffRows.values()].sort((a, b) =>
      (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''),
    );
  }
  async rememberStaff(entry: { userId: string; displayName: string }, at: string) {
    this.staffRows.set(entry.userId, { ...entry, lastUsedAt: at });
  }
}

// --- command log + cursors on SQLite ----------------------------------------------------------

export class SqliteCommandLogStore implements CommandLogStore {
  constructor(private readonly db: SqlDatabase) {}

  private toCommand(row: Record<string, unknown>): LocalCommand {
    return {
      clientCommandId: row.client_command_id as string,
      seq: Number(row.seq),
      type: row.type as string,
      payload: JSON.parse(row.payload as string) as Record<string, unknown>,
      hlc: row.hlc as string,
      clientTime: row.created_at as string,
      status: row.status as CommandStatus,
      batchId: (row.batch_id as string | null) ?? null,
      serverResult: row.server_result
        ? (JSON.parse(row.server_result as string) as CommandOutcome)
        : null,
    };
  }

  async append(c: LocalCommand): Promise<void> {
    await this.db.execute(
      `INSERT INTO commands (client_command_id, seq, type, payload, hlc, created_at, status, batch_id, server_result)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        c.clientCommandId,
        c.seq,
        c.type,
        JSON.stringify(c.payload),
        c.hlc,
        c.clientTime,
        c.status,
        c.batchId,
        c.serverResult ? JSON.stringify(c.serverResult) : null,
      ],
    );
  }

  async get(id: string) {
    const rows = await this.db.select('SELECT * FROM commands WHERE client_command_id = $1', [id]);
    return rows[0] ? this.toCommand(rows[0]) : null;
  }

  async list(statuses: readonly CommandStatus[], limit?: number) {
    if (statuses.length === 0) return [];
    const rows = await this.db.select(
      `SELECT * FROM commands WHERE status IN (${placeholders(statuses.length)}) ORDER BY seq${
        limit !== undefined && Number.isFinite(limit)
          ? ` LIMIT ${Math.max(0, Math.floor(limit))}`
          : ''
      }`,
      [...statuses],
    );
    return rows.map((r) => this.toCommand(r));
  }

  async update(
    ids: readonly string[],
    patch: Partial<Pick<LocalCommand, 'status' | 'batchId' | 'serverResult'>>,
  ): Promise<void> {
    if (ids.length === 0) return;
    const sets: string[] = [];
    const params: SqlValue[] = [];
    const add = (column: string, value: SqlValue) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.batchId !== undefined) add('batch_id', patch.batchId);
    if (patch.serverResult !== undefined)
      add('server_result', patch.serverResult ? JSON.stringify(patch.serverResult) : null);
    if (sets.length === 0) return;
    await this.db.execute(
      `UPDATE commands SET ${sets.join(', ')} WHERE client_command_id IN (${placeholders(ids.length, params.length + 1)})`,
      [...params, ...ids],
    );
  }

  async maxSeq() {
    const rows = await this.db.select<{ m: number | null }>('SELECT MAX(seq) AS m FROM commands');
    return Number(rows[0]?.m ?? 0);
  }

  async count(statuses: readonly CommandStatus[]) {
    if (statuses.length === 0) return 0;
    const rows = await this.db.select<{ n: number }>(
      `SELECT COUNT(*) AS n FROM commands WHERE status IN (${placeholders(statuses.length)})`,
      [...statuses],
    );
    return Number(rows[0]?.n ?? 0);
  }
}

export class SqliteCursorStore implements CursorStore {
  constructor(private readonly db: SqlDatabase) {}
  async get(stream: FeedStream) {
    const rows = await this.db.select<{ cursor: number }>(
      'SELECT cursor FROM replica_cursors WHERE stream = $1',
      [stream],
    );
    return rows[0] ? Number(rows[0].cursor) : null;
  }
  async set(stream: FeedStream, cursor: number) {
    await this.db.execute(
      `INSERT INTO replica_cursors (stream, cursor) VALUES ($1, $2)
       ON CONFLICT(stream) DO UPDATE SET cursor = excluded.cursor`,
      [stream, cursor],
    );
  }
}

// --- local projections ------------------------------------------------------------------------

export interface ProjectionStore {
  put(kind: string, id: string, payload: unknown, hlc: string): Promise<void>;
  get<T>(kind: string, id: string): Promise<T | null>;
  list<T>(kind: string): Promise<T[]>;
  delete(kind: string, id: string): Promise<void>;
}

export class SqliteProjectionStore implements ProjectionStore {
  constructor(private readonly db: SqlDatabase) {}
  async put(kind: string, id: string, payload: unknown, hlc: string) {
    await this.db.execute(
      `INSERT INTO local_projections (kind, id, payload, updated_hlc) VALUES ($1, $2, $3, $4)
       ON CONFLICT(kind, id) DO UPDATE SET payload = excluded.payload, updated_hlc = excluded.updated_hlc`,
      [kind, id, JSON.stringify(payload), hlc],
    );
  }
  async get<T>(kind: string, id: string) {
    const rows = await this.db.select<{ payload: string }>(
      'SELECT payload FROM local_projections WHERE kind = $1 AND id = $2',
      [kind, id],
    );
    return rows[0] ? (JSON.parse(rows[0].payload) as T) : null;
  }
  async list<T>(kind: string) {
    const rows = await this.db.select<{ payload: string }>(
      'SELECT payload FROM local_projections WHERE kind = $1 ORDER BY updated_hlc',
      [kind],
    );
    return rows.map((r) => JSON.parse(r.payload) as T);
  }
  async delete(kind: string, id: string) {
    await this.db.execute('DELETE FROM local_projections WHERE kind = $1 AND id = $2', [kind, id]);
  }
}

export class MemoryProjectionStore implements ProjectionStore {
  private readonly rows = new Map<string, { payload: unknown; hlc: string }>();
  async put(kind: string, id: string, payload: unknown, hlc: string) {
    this.rows.set(`${kind}\u0000${id}`, { payload: structuredClone(payload), hlc });
  }
  async get<T>(kind: string, id: string) {
    const r = this.rows.get(`${kind}\u0000${id}`);
    return r ? (structuredClone(r.payload) as T) : null;
  }
  async list<T>(kind: string) {
    return [...this.rows.entries()]
      .filter(([k]) => k.startsWith(`${kind}\u0000`))
      .sort((a, b) => a[1].hlc.localeCompare(b[1].hlc))
      .map(([, v]) => structuredClone(v.payload) as T);
  }
  async delete(kind: string, id: string) {
    this.rows.delete(`${kind}\u0000${id}`);
  }
}

// --- composition ------------------------------------------------------------------------------

export interface LocalStore {
  readonly kind: 'sqlite' | 'memory';
  /** Encryption at rest status for the diagnostics screen. */
  readonly encryption: 'simulated' | 'sqlcipher' | 'none';
  readonly commands: CommandLogStore;
  readonly cursors: CursorStore;
  readonly replicas: ReplicaStore;
  readonly projections: ProjectionStore;
}

export function createMemoryStore(): LocalStore {
  return {
    kind: 'memory',
    encryption: 'none',
    commands: new MemoryCommandLogStore(),
    cursors: new MemoryCursorStore(),
    replicas: new MemoryReplicaStore(),
    projections: new MemoryProjectionStore(),
  };
}

export function createSqliteStore(
  db: SqlDatabase,
  encryption: LocalStore['encryption'],
): LocalStore {
  return {
    kind: 'sqlite',
    encryption,
    commands: new SqliteCommandLogStore(db),
    cursors: new SqliteCursorStore(db),
    replicas: new SqliteReplicaStore(db),
    projections: new SqliteProjectionStore(db),
  };
}
