import { describe, expect, it } from 'vitest';

import { CommandLog, SyncUploader, type BatchTransport } from './command-log.js';
import { MemoryCommandLogStore } from './commands.js';
import { HybridLogicalClock, compareHlc, parseHlc } from './hlc.js';
import type { CommandOutcome, SyncBatchResult } from './index.js';

function ids(prefix: string) {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(4, '0')}`;
}

/** A server double: idempotent on clientCommandId, processes batches in order, can be told to crash. */
class FakeServer {
  readonly applied: string[] = [];
  private seq = 0;
  rejectTypes = new Set<string>();
  failNext = false;
  /** Simulate the request reaching the server but the response being lost. */
  loseResponseNext = false;

  transport: BatchTransport = async (batch) => {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('network down');
    }
    const outcomes: CommandOutcome[] = batch.commands.map((c) => {
      if (this.rejectTypes.has(c.type)) return { status: 'rejected', code: 'LIMIT_EXCEEDED' };
      if (this.applied.includes(c.clientCommandId)) return { status: 'duplicate' };
      this.applied.push(c.clientCommandId);
      return { status: 'applied', serverSeq: ++this.seq };
    });
    const result: SyncBatchResult = { clientBatchId: batch.clientBatchId, outcomes };
    if (this.loseResponseNext) {
      this.loseResponseNext = false;
      throw new Error('response lost');
    }
    return result;
  };
}

let restarts = 0;
async function makeLog(store = new MemoryCommandLogStore(), node = 'reg-1') {
  let t = 1_000;
  const clock = new HybridLogicalClock(node, () => (t += 1));
  // Real ids are UUIDs; the test prefix changes per process start so a restart never collides.
  const log = new CommandLog(store, clock, {
    newId: ids(`${node}-p${++restarts}`),
    now: () => new Date(t),
  });
  await log.init();
  return { log, store, clock };
}

describe('CommandLog append', () => {
  it('is durable before the promise resolves and numbers commands in device order', async () => {
    const { log, store } = await makeLog();
    const a = await log.append('cart.line.add', { lineId: 'l1' });
    expect(await store.get(a.clientCommandId)).toMatchObject({ seq: 1, status: 'pending' });
    const b = await log.append('cart.line.add', { lineId: 'l2' });
    expect(b.seq).toBe(2);
    expect(compareHlc(parseHlc(a.hlc), parseHlc(b.hlc))).toBe(-1);
    expect(await log.pendingCount()).toBe(2);
  });

  it('keeps seq and HLC monotonic under concurrent appends', async () => {
    const { log } = await makeLog();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => log.append('cart.line.add', { i })),
    );
    const seqs = results.map((r) => r.seq);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    for (let i = 1; i < results.length; i++)
      expect(compareHlc(parseHlc(results[i - 1]!.hlc), parseHlc(results[i]!.hlc))).toBe(-1);
  });

  it('refuses to be used before init()', async () => {
    const log = new CommandLog(new MemoryCommandLogStore(), new HybridLogicalClock('x'));
    await expect(log.append('t', {})).rejects.toThrow(/init/);
  });
});

describe('ordering across devices', () => {
  it('sorts facts from two registers by HLC, with each register’s own order preserved', async () => {
    let t = 5_000;
    const now = () => (t += 3);
    const clockA = new HybridLogicalClock('reg-a', now);
    const clockB = new HybridLogicalClock('reg-b', now);
    const a = new CommandLog(new MemoryCommandLogStore(), clockA, { newId: ids('a') });
    const b = new CommandLog(new MemoryCommandLogStore(), clockB, { newId: ids('b') });
    await a.init();
    await b.init();
    const a1 = await a.append('t', { n: 1 });
    const b1 = await b.append('t', { n: 2 });
    const a2 = await a.append('t', { n: 3 });
    // reg-b hears about a2 (e.g. via the feed) before producing its next command
    b.observe(parseHlc(a2.hlc));
    const b2 = await b.append('t', { n: 4 });
    const all = [b2, a2, b1, a1].sort((x, y) => compareHlc(parseHlc(x.hlc), parseHlc(y.hlc)));
    expect(all.map((c) => c.payload.n)).toEqual([1, 2, 3, 4]);
    // string form sorts the same way
    const strings = [b2, a2, b1, a1].map((c) => c.hlc).sort();
    expect(strings).toEqual(all.map((c) => c.hlc));
  });
});

describe('upload and idempotent replay', () => {
  it('drains pending commands in order and marks them acked', async () => {
    const { log } = await makeLog();
    const server = new FakeServer();
    const uploader = new SyncUploader(log, 'dev-1', server.transport);
    const c1 = await log.append('cart.line.add', { lineId: 'l1' });
    const c2 = await log.append('cart.line.add', { lineId: 'l2' });
    expect(await uploader.drain()).toBe(1);
    expect(server.applied).toEqual([c1.clientCommandId, c2.clientCommandId]);
    expect((await log.list(['acked'])).map((c) => c.seq)).toEqual([1, 2]);
    expect(await log.pendingCount()).toBe(0);
  });

  it('splits into batches of at most maxBatchSize', async () => {
    const store = new MemoryCommandLogStore();
    const log = new CommandLog(store, new HybridLogicalClock('r'), {
      newId: ids('r'),
      maxBatchSize: 2,
    });
    await log.init();
    for (let i = 0; i < 5; i++) await log.append('t', { i });
    const server = new FakeServer();
    expect(await new SyncUploader(log, 'dev', server.transport).drain()).toBe(3);
    expect(server.applied).toHaveLength(5);
  });

  it('a lost response is replayed and the server answers duplicate, which counts as acked', async () => {
    const { log } = await makeLog();
    const server = new FakeServer();
    const uploader = new SyncUploader(log, 'dev-1', server.transport);
    const c1 = await log.append('cart.line.add', { lineId: 'l1' });
    server.loseResponseNext = true;
    await expect(uploader.drain()).rejects.toThrow('response lost');
    // The server applied it, but we never heard: the command is pending again, not lost.
    expect(server.applied).toEqual([c1.clientCommandId]);
    expect((await log.list(['pending'])).map((c) => c.clientCommandId)).toEqual([
      c1.clientCommandId,
    ]);
    expect(await uploader.drain()).toBe(1);
    expect(server.applied).toEqual([c1.clientCommandId]); // applied exactly once
    expect((await log.list(['acked']))[0]?.serverResult).toEqual({ status: 'duplicate' });
  });

  it('a transport failure before the server saw the batch returns commands to pending', async () => {
    const { log } = await makeLog();
    const server = new FakeServer();
    const uploader = new SyncUploader(log, 'dev-1', server.transport);
    await log.append('t', {});
    server.failNext = true;
    await expect(uploader.drain()).rejects.toThrow('network down');
    expect(await log.pendingCount()).toBe(1);
    expect(server.applied).toHaveLength(0);
    expect(await uploader.drain()).toBe(1);
    expect(await log.pendingCount()).toBe(0);
  });

  it('rejected commands keep the server result and leave the batch order intact', async () => {
    const { log } = await makeLog();
    const server = new FakeServer();
    server.rejectTypes.add('order.void');
    const uploader = new SyncUploader(log, 'dev-1', server.transport);
    await log.append('cart.line.add', {});
    const voided = await log.append('order.void', {});
    await log.append('cart.line.add', {});
    await uploader.drain();
    const rejected = await log.rejected();
    expect(rejected.map((c) => c.clientCommandId)).toEqual([voided.clientCommandId]);
    expect(rejected[0]?.serverResult).toEqual({ status: 'rejected', code: 'LIMIT_EXCEEDED' });
    expect(await log.list(['acked'])).toHaveLength(2);
  });

  it('a partial answer (fewer outcomes than commands) returns the unanswered tail to pending', async () => {
    const { log } = await makeLog();
    await log.append('t', { n: 1 });
    await log.append('t', { n: 2 });
    const batch = (await log.nextBatch('dev'))!;
    await log.applyBatchResult(batch, {
      clientBatchId: batch.clientBatchId,
      outcomes: [{ status: 'applied', serverSeq: 1 }],
    });
    expect((await log.list(['acked'])).map((c) => c.seq)).toEqual([1]);
    expect((await log.list(['pending'])).map((c) => c.seq)).toEqual([2]);
  });

  it('refuses a result for a different batch', async () => {
    const { log } = await makeLog();
    await log.append('t', {});
    const batch = (await log.nextBatch('dev'))!;
    await expect(
      log.applyBatchResult(batch, { clientBatchId: 'other', outcomes: [] }),
    ).rejects.toThrow(/does not match/);
  });
});

describe('crash recovery', () => {
  it('a restart over the same store resumes the sequence and resends in-flight commands once', async () => {
    const store = new MemoryCommandLogStore();
    const first = await makeLog(store, 'reg-1');
    const server = new FakeServer();
    await first.log.append('t', { n: 1 });
    await first.log.append('t', { n: 2 });
    // The batch is taken (in flight) and then the process dies before the upload completes.
    const batch = await first.log.nextBatch('dev-1');
    expect(batch?.commands).toHaveLength(2);
    expect(await store.count(['in_flight'])).toBe(2);

    // Restart: a new log over the same rows.
    const second = await makeLog(store, 'reg-1');
    expect(await store.count(['in_flight'])).toBe(0);
    expect(await store.count(['pending'])).toBe(2);
    const c3 = await second.log.append('t', { n: 3 });
    expect(c3.seq).toBe(3); // sequence continues, never reused
    const previous = (await second.log.list(['pending']))[1]!;
    expect(compareHlc(parseHlc(previous.hlc), parseHlc(c3.hlc))).toBe(-1);

    const uploader = new SyncUploader(second.log, 'dev-1', server.transport);
    expect(await uploader.drain()).toBe(1);
    expect(server.applied).toHaveLength(3);
    expect((await second.log.list(['acked'])).map((c) => c.payload.n)).toEqual([1, 2, 3]);
  });

  it('a crash after the server applied the batch but before the ack was stored is harmless', async () => {
    const store = new MemoryCommandLogStore();
    const first = await makeLog(store, 'reg-1');
    const server = new FakeServer();
    await first.log.append('t', { n: 1 });
    const batch = (await first.log.nextBatch('dev-1'))!;
    await server.transport(batch); // server applied; process dies before applyBatchResult
    const second = await makeLog(store, 'reg-1');
    expect(second.log.init).toBeDefined();
    const uploader = new SyncUploader(second.log, 'dev-1', server.transport);
    await uploader.drain();
    expect(server.applied).toHaveLength(1);
    expect((await second.log.list(['acked']))[0]?.serverResult).toEqual({ status: 'duplicate' });
  });

  it('reports how many commands were recovered and notifies subscribers', async () => {
    const store = new MemoryCommandLogStore();
    const first = await makeLog(store);
    await first.log.append('t', {});
    await first.log.nextBatch('dev');
    const log = new CommandLog(store, new HybridLogicalClock('reg-1'), { newId: ids('x') });
    const events: string[] = [];
    log.subscribe((e) => events.push(e.kind));
    expect(await log.init()).toEqual({ recovered: 1 });
    expect(events).toEqual(['recovered']);
  });
});
