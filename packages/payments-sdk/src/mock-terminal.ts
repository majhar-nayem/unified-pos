import { randomUUID } from 'node:crypto';

import type {
  PairingResult,
  PaymentProviderAdapter,
  ProviderStatus,
  TerminalAdapter,
  TerminalEvent,
  TerminalHealth,
  TerminalInfo,
  TerminalRequest,
  TerminalSession,
} from './adapter.js';
import { idempotencyKey } from './adapter.js';

/**
 * In-memory terminal (docs/01 §7.4 TerminalAdapter) driving a provider adapter: pairing by a
 * 6-digit code, progress events, cancellation, last-result recovery and offline approval when the
 * request allows it and the connection mode supports store-and-forward.
 */
export class MockTerminalAdapter implements TerminalAdapter {
  private readonly paired = new Map<string, { pairingRef: string; firmware: string }>();
  private readonly lastResult = new Map<string, ProviderStatus>();
  private readonly cancelled = new Set<string>();
  private readonly offlineQueue = new Map<string, { count: number; sumMinor: bigint }>();
  /** When true the terminal cannot reach the provider and approves offline if allowed. */
  providerUnreachable = false;

  constructor(
    private readonly provider: PaymentProviderAdapter,
    private readonly validCode = '123456',
  ) {}

  async pair(terminal: TerminalInfo, code: string): Promise<PairingResult> {
    if (code !== this.validCode) return { outcome: 'rejected', reason: 'invalid_code' };
    const pairingRef = `term_${terminal.serialNumber}_${randomUUID().slice(0, 8)}`;
    this.paired.set(terminal.serialNumber, { pairingRef, firmware: '1.0.0-mock' });
    return { outcome: 'paired', pairingRef, model: 'MockPad 1', firmware: '1.0.0-mock' };
  }

  async *startTransaction(
    session: TerminalSession,
    req: TerminalRequest,
  ): AsyncIterable<TerminalEvent> {
    const serial = session.terminal.serialNumber;
    if (!this.paired.has(serial)) throw new Error('Terminal is not paired');
    yield { kind: 'display', message: 'Present card' };
    if (this.cancelled.delete(session.sessionId)) {
      yield { kind: 'cancelled' };
      return;
    }
    yield { kind: 'card_presented', entryMode: 'contactless' };
    yield { kind: 'authorizing' };
    const canOffline =
      req.allowOffline &&
      this.provider.capabilities({
        id: 'terminal',
        provider: session.terminal.provider,
        currency: req.amount.currency,
        credentialsRef: 'terminal',
      }).offlineModes[session.terminal.connectionMode] !== 'none';
    if (this.providerUnreachable) {
      if (!canOffline) {
        const result = {
          outcome: 'declined' as const,
          code: 'offline_not_allowed',
          message: 'Terminal offline',
        };
        this.lastResult.set(serial, { state: 'declined', amount: req.amount });
        yield { kind: 'result', result, offline: false };
        return;
      }
      const queue = this.offlineQueue.get(serial) ?? { count: 0, sumMinor: 0n };
      queue.count += 1;
      queue.sumMinor += req.amount.amountMinor;
      this.offlineQueue.set(serial, queue);
      const ref = {
        provider: session.terminal.provider,
        providerPaymentId: `offline_${randomUUID()}`,
      };
      this.lastResult.set(serial, { state: 'captured', amount: req.amount });
      yield {
        kind: 'result',
        offline: true,
        receiptText: 'OFFLINE APPROVED\nVISA ****4242',
        result: {
          outcome: 'approved',
          ref,
          amount: req.amount,
          masked: { scheme: 'visa', last4: '4242', entryMode: 'contactless' },
        },
      };
      return;
    }
    const result = await this.provider.createPayment(
      {
        account: {
          id: 'terminal',
          provider: session.terminal.provider,
          currency: req.amount.currency,
          credentialsRef: 'terminal',
        },
        amount: req.amount,
        intentId: req.intentId,
        capture: req.capture,
        reference: req.reference,
      },
      idempotencyKey(`${req.intentId}:terminal:${session.sessionId}`),
    );
    this.lastResult.set(
      serial,
      result.outcome === 'approved'
        ? { state: req.capture === 'auto' ? 'captured' : 'authorized', amount: result.amount }
        : result.outcome === 'declined'
          ? { state: 'declined', amount: req.amount }
          : { state: 'unknown' },
    );
    yield {
      kind: 'result',
      result,
      offline: false,
      receiptText: result.outcome === 'approved' ? result.masked?.terminalReceiptText : undefined,
    };
  }

  async cancel(session: TerminalSession): Promise<void> {
    this.cancelled.add(session.sessionId);
  }

  async lastTransactionResult(terminal: TerminalInfo): Promise<ProviderStatus> {
    return this.lastResult.get(terminal.serialNumber) ?? { state: 'unknown' };
  }

  async health(terminal: TerminalInfo): Promise<TerminalHealth> {
    const paired = this.paired.get(terminal.serialNumber);
    return {
      online: paired !== undefined && !this.providerUnreachable,
      lastSeenAt: paired ? new Date() : null,
      ...(paired ? { firmware: paired.firmware } : {}),
      offlineQueued: this.offlineQueue.get(terminal.serialNumber) ?? { count: 0, sumMinor: 0n },
    };
  }
}
