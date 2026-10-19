import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  MockReceiptPrinter,
  twoColumns,
  type CashDrawer,
  type DiagnosticsRow,
  type ReceiptPrinter,
} from '@pos/hardware';

import { useServices } from '../app/services.js';
import { useSyncQueue } from '../hooks/useSyncQueue.js';
import { Button } from '../ui/primitives.js';

const STATE_LABEL: Record<string, string> = {
  ready: '✓ Ready',
  degraded: '⚠ Needs attention',
  offline: '✕ Offline',
  unknown: '? Unknown',
};

/** Lists peripherals and their status (docs/03 §5 F6), plus the local-store facts a support call needs. */
export function DiagnosticsScreen({ onBack }: { onBack: () => void }) {
  const { hardware, store, keys, secrets, sync, log, appVersion, session } = useServices();
  const [rows, setRows] = useState<DiagnosticsRow[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const syncStatus = useSyncExternalStore(sync.subscribe, sync.getStatus);
  const queue = useSyncQueue(log);

  const refresh = useCallback(
    async () => setRows(await hardware.manager.diagnostics()),
    [hardware],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function testPrint(printer: ReceiptPrinter) {
    const result = await printer.print({
      lines: [
        { text: 'DIAGNOSTIC PRINT', align: 'center', bold: true },
        { rule: true },
        twoColumns(
          'Register',
          session.getState().phase === 'signed_in' ? 'signed in' : 'signed out',
          32,
        ),
        new Date().toISOString(),
      ],
      cut: true,
    });
    setMessage(
      result.ok
        ? 'Test receipt sent.'
        : `Print failed: ${result.error ?? 'unknown error'}${result.retryable ? ' (safe to retry)' : ''}`,
    );
    await refresh();
  }

  const printers = hardware.manager.ofKind<ReceiptPrinter>('receipt_printer');
  const mockPrinter = printers.find(
    (p): p is MockReceiptPrinter => p instanceof MockReceiptPrinter,
  );
  const drawers = hardware.manager.ofKind<CashDrawer>('cash_drawer');

  return (
    <main className="page">
      <div className="row">
        <h1 style={{ fontSize: 28 }}>Diagnostics</h1>
        <span style={{ flex: 1 }} />
        <Button onClick={() => void refresh()}>Re-check</Button>
        <Button variant="primary" onClick={onBack}>
          Back to register
        </Button>
      </div>

      {message ? (
        <p role="status" className="muted">
          {message}
        </p>
      ) : null}

      <section aria-labelledby="peripherals-title" className="stack">
        <h2 id="peripherals-title" style={{ fontSize: 20 }}>
          Peripherals
        </h2>
        {hardware.simulated ? (
          <p className="muted">All peripherals are simulated in this build.</p>
        ) : null}
        {rows === null ? (
          <p>Checking…</p>
        ) : rows.length === 0 ? (
          <p>No peripherals are configured on this register.</p>
        ) : (
          <table className="diag">
            <thead>
              <tr>
                <th scope="col">Device</th>
                <th scope="col">Kind</th>
                <th scope="col">Connection</th>
                <th scope="col">Status</th>
                <th scope="col">Detail</th>
                <th scope="col">Check time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <th scope="row">{r.name}</th>
                  <td>{r.kind.replace('_', ' ')}</td>
                  <td>
                    {r.transport}
                    {r.address ? ` · ${r.address}` : ''}
                  </td>
                  <td>{STATE_LABEL[r.state] ?? r.state}</td>
                  <td>{r.detail ?? '—'}</td>
                  <td>{r.latencyMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="row">
          {printers.map((p) => (
            <Button key={p.profile.id} onClick={() => void testPrint(p)}>
              Test print: {p.profile.name}
            </Button>
          ))}
          {printers.map((p) =>
            p.kickDrawer ? (
              <Button
                key={`kick-${p.profile.id}`}
                onClick={() =>
                  void p.kickDrawer!().then((r) =>
                    setMessage(r.ok ? 'Drawer pulse sent.' : `Drawer failed: ${r.error}`),
                  )
                }
              >
                Open drawer via {p.profile.name}
              </Button>
            ) : null,
          )}
          {drawers.map((d) => (
            <Button
              key={d.profile.id}
              onClick={() =>
                void d
                  .open()
                  .then((r) => setMessage(r.ok ? 'Drawer opened.' : `Drawer failed: ${r.error}`))
              }
            >
              Open {d.profile.name}
            </Button>
          ))}
          {mockPrinter ? (
            <Button
              aria-pressed={mockPrinter.offline}
              onClick={() => {
                mockPrinter.offline = !mockPrinter.offline;
                void refresh();
              }}
            >
              {mockPrinter.offline
                ? 'Simulated printer: offline (tap to restore)'
                : 'Simulate printer offline'}
            </Button>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="store-title" className="stack">
        <h2 id="store-title" style={{ fontSize: 20 }}>
          This register
        </h2>
        <table className="diag">
          <tbody>
            <tr>
              <th scope="row">App version</th>
              <td>{appVersion}</td>
            </tr>
            <tr>
              <th scope="row">Local store</th>
              <td>
                {store.kind === 'sqlite'
                  ? 'SQLite (WAL)'
                  : 'In memory (browser development build: data is lost on reload)'}
              </td>
            </tr>
            <tr>
              <th scope="row">Encrypted at rest</th>
              <td>
                {store.encryption === 'sqlcipher'
                  ? 'Yes (SQLCipher)'
                  : store.encryption === 'simulated'
                    ? 'Simulated: SQLCipher is not wired yet, the file is not encrypted'
                    : 'No'}
              </td>
            </tr>
            <tr>
              <th scope="row">Device key</th>
              <td>{keys.kind === 'os_keychain' ? 'OS keychain' : 'Simulated keychain'}</td>
            </tr>
            <tr>
              <th scope="row">Secrets (refresh token)</th>
              <td>{secrets.kind === 'os_keychain' ? 'OS keychain' : 'Simulated storage'}</td>
            </tr>
            <tr>
              <th scope="row">Catalogue replica</th>
              <td>
                {syncStatus.replica
                  ? syncStatus.replica.source === 'stub'
                    ? 'Stub demo data (no server feed yet)'
                    : syncStatus.replica.source === 'feed'
                      ? 'Change feed'
                      : 'Offline, last copy'
                  : 'Not loaded'}
              </td>
            </tr>
            <tr>
              <th scope="row">Unsynced commands</th>
              <td>
                {queue.unsynced}
                {queue.rejected ? ` (${queue.rejected} rejected)` : ''}
              </td>
            </tr>
            <tr>
              <th scope="row">Last sync</th>
              <td>
                {syncStatus.lastSyncAt
                  ? new Date(syncStatus.lastSyncAt).toLocaleTimeString('en-AU')
                  : 'Never'}
                {syncStatus.uploadError ? ` · ${syncStatus.uploadError}` : ''}
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </main>
  );
}
