import { money } from '@pos/domain-core';
import { describe, expect, it } from 'vitest';

import type { TerminalEvent, TerminalInfo } from './adapter.js';
import { MockPaymentProvider } from './mock-provider.js';
import { MockTerminalAdapter } from './mock-terminal.js';

const terminal: TerminalInfo = {
  id: 't1',
  provider: 'mock',
  serialNumber: 'SN-1',
  connectionMode: 'lan',
};

async function collect(events: AsyncIterable<TerminalEvent>): Promise<TerminalEvent[]> {
  const out: TerminalEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('MockTerminalAdapter', () => {
  it('pairs with the code, runs a transaction with progress events and remembers the last result', async () => {
    const provider = new MockPaymentProvider();
    const adapter = new MockTerminalAdapter(provider);
    expect(await adapter.pair(terminal, '000000')).toMatchObject({ outcome: 'rejected' });
    const paired = await adapter.pair(terminal, '123456');
    expect(paired.outcome).toBe('paired');
    const events = await collect(
      adapter.startTransaction(
        { terminal, sessionId: 's1' },
        {
          intentId: 'i1',
          amount: money(1000, 'AUD'),
          capture: 'auto',
          reference: 'R',
          allowOffline: false,
        },
      ),
    );
    expect(events.map((e) => e.kind)).toEqual([
      'display',
      'card_presented',
      'authorizing',
      'result',
    ]);
    expect(await adapter.lastTransactionResult(terminal)).toMatchObject({ state: 'captured' });
    expect((await adapter.health(terminal)).online).toBe(true);
  });

  it('approves offline only when allowed and the connection mode supports it; cancel stops the flow', async () => {
    const provider = new MockPaymentProvider();
    const adapter = new MockTerminalAdapter(provider);
    await adapter.pair(terminal, '123456');
    adapter.providerUnreachable = true;
    const cloud: TerminalInfo = { ...terminal, connectionMode: 'cloud' };
    const req = {
      intentId: 'i2',
      amount: money(1000, 'AUD'),
      capture: 'auto' as const,
      reference: 'R',
      allowOffline: true,
    };
    const refused = await collect(
      adapter.startTransaction({ terminal: cloud, sessionId: 's2' }, req),
    );
    expect(refused.at(-1)).toMatchObject({
      kind: 'result',
      offline: false,
      result: { outcome: 'declined', code: 'offline_not_allowed' },
    });
    const offline = await collect(adapter.startTransaction({ terminal, sessionId: 's3' }, req));
    expect(offline.at(-1)).toMatchObject({
      kind: 'result',
      offline: true,
      result: { outcome: 'approved' },
    });
    expect((await adapter.health(terminal)).offlineQueued).toEqual({ count: 1, sumMinor: 1000n });
    expect(provider.chargeCount).toBe(0);

    await adapter.cancel({ terminal, sessionId: 's4' });
    const cancelled = await collect(adapter.startTransaction({ terminal, sessionId: 's4' }, req));
    expect(cancelled.map((e) => e.kind)).toEqual(['display', 'cancelled']);
  });
});
