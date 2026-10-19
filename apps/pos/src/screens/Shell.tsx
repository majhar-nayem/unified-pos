import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { PeripheralStatus, ReceiptPrinter, Scanner } from '@pos/hardware';

import { useServices } from '../app/services.js';
import { cartSubtotalMinor, formatMinor, lineTotalMinor } from '../cart/cart.js';
import type { ScanOutcome } from '../cart/scan.js';
import { openCfdWindow, type CfdMessage } from '../cfd/channel.js';
import { useConnectivity } from '../hooks/connectivity.js';
import { useDeviceClass } from '../hooks/useDeviceClass.js';
import { useScannerCapture } from '../hooks/useScannerCapture.js';
import { useSyncQueue } from '../hooks/useSyncQueue.js';
import { isTauri } from '../platform/runtime.js';
import type { SessionState } from '../session/session-manager.js';
import { Banner, Button, formatClock } from '../ui/primitives.js';
import { ConnectivityIndicator, SyncBadge } from '../ui/status.js';
import { CartPane } from './CartPane.js';
import { ProductPane } from './ProductPane.js';

type SignedIn = Extract<SessionState, { phase: 'signed_in' }>;

/** Polls the receipt printer so a failure shows recovery UI instead of surprising the cashier at the end of a sale. */
export function usePrinterStatus(intervalMs = 30_000): {
  status: PeripheralStatus | null;
  recheck: () => void;
} {
  const { hardware } = useServices();
  const [status, setStatus] = useState<PeripheralStatus | null>(null);
  const check = useCallback(async () => {
    const printer = hardware.manager.first<ReceiptPrinter>('receipt_printer');
    setStatus(printer ? await printer.status() : null);
  }, [hardware]);
  useEffect(() => {
    void check();
    const handle = setInterval(() => void check(), intervalMs);
    return () => clearInterval(handle);
  }, [check, intervalMs]);
  return { status, recheck: () => void check() };
}

export function Shell({
  state,
  onNavigate,
}: {
  state: SignedIn;
  onNavigate: (route: 'diagnostics') => void;
}) {
  const services = useServices();
  const {
    session,
    connectivity,
    log,
    cart: cartService,
    hardware,
    sync,
    cfd,
    staff,
    currency,
  } = services;
  const deviceClass = useDeviceClass();
  const conn = useConnectivity(connectivity);
  const queue = useSyncQueue(log);
  const syncStatus = useSyncExternalStore(sync.subscribe, sync.getStatus);
  const cart = useSyncExternalStore(cartService.subscribe, cartService.getCart);
  useSyncExternalStore(staff.subscribe, staff.getVersion);
  const cashier = staff.nameOf(state.staff.userId) ?? 'Staff';
  const printer = usePrinterStatus();
  const [menuOpen, setMenuOpen] = useState(false);
  const [cartCollapsed, setCartCollapsed] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'info' | 'warning'; text: string } | null>(null);
  const [clock, setClock] = useState(() => formatClock(new Date()));
  const [recovered, setRecovered] = useState(cartService.recovered);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // --- lifecycle: connectivity probe + background sync ---------------------------------------
  useEffect(() => {
    connectivity.start();
    void sync.syncNow();
    const handle = setInterval(() => void sync.syncNow(), 30_000);
    return () => {
      clearInterval(handle);
      connectivity.stop();
    };
  }, [connectivity, sync]);

  useEffect(() => {
    if (conn.status === 'online') void sync.syncNow();
  }, [conn.status, sync]);

  useEffect(() => {
    const t = setInterval(() => setClock(formatClock(new Date())), 15_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const off = cartService.subscribe(() => setRecovered(cartService.recovered));
    return () => {
      off();
    };
  }, [cartService]);

  // --- CFD mirror ------------------------------------------------------------------------------
  useEffect(() => {
    if (!cfd) return;
    const message: CfdMessage =
      cart.lines.length === 0
        ? { type: 'idle' }
        : {
            type: 'cart',
            currency,
            lines: cart.lines.map((l) => ({
              name: l.name,
              quantity: l.quantity,
              totalMinor: lineTotalMinor(l).toString(),
            })),
            totalMinor: cartSubtotalMinor(cart).toString(),
          };
    cfd.postMessage(message);
  }, [cfd, cart, currency]);

  // --- scanner capture + F2 ----------------------------------------------------------------------
  const scanners = useMemo(() => hardware.manager.ofKind<Scanner>('scanner'), [hardware]);
  const onResult = useCallback((outcome: ScanOutcome) => {
    if (outcome.ok) setNotice({ tone: 'info', text: `Added ${outcome.line.name}` });
    else if (outcome.reason === 'not_found')
      setNotice({ tone: 'warning', text: `No product with code ${outcome.code}.` });
    else setNotice({ tone: 'warning', text: 'Waiting for a stable weight on the scale.' });
  }, []);
  useScannerCapture(
    (event) => {
      void services.scan.handleScan(event.code).then(onResult);
    },
    { scanners },
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const collapsible = deviceClass === 'tablet-portrait' || deviceClass === 'handheld';
  const offline = conn.status === 'offline';
  const storeLabel =
    syncStatus.replica?.source === 'stub'
      ? 'Demo store'
      : `Location ${state.identity.locationId.slice(0, 8)}`;
  const printerDown = printer.status !== null && !printer.status.online;

  return (
    <div className={`shell shell--${deviceClass}`}>
      <header className="app-header">
        <ConnectivityIndicator state={conn} />
        <span className="hide-handheld">Store: {storeLabel}</span>
        <span className="hide-handheld">{state.identity.deviceName}</span>
        <span className="hide-handheld">Cashier: {cashier}</span>
        <SyncBadge queue={queue} />
        <span className="spacer" />
        <span className="hide-handheld" aria-label="Time">
          {clock}
        </span>
        <Button
          aria-haspopup="true"
          aria-expanded={menuOpen}
          aria-controls="register-menu"
          onClick={() => setMenuOpen((o) => !o)}
        >
          ☰ Menu
        </Button>
        {menuOpen ? (
          <nav id="register-menu" className="menu-panel" aria-label="Register menu">
            <p className="muted menu-info">
              {state.identity.deviceName} · {storeLabel} · Cashier: {cashier}
            </p>
            <Button
              onClick={() => {
                setMenuOpen(false);
                void openCfdWindow(isTauri());
              }}
            >
              Customer display
            </Button>
            <Button
              onClick={() => {
                setMenuOpen(false);
                onNavigate('diagnostics');
              }}
            >
              Diagnostics
            </Button>
            <Button
              onClick={() => {
                setMenuOpen(false);
                void sync.syncNow();
              }}
            >
              Sync now
            </Button>
            <Button
              onClick={() => {
                setMenuOpen(false);
                void session.signOut();
              }}
            >
              Sign out
            </Button>
          </nav>
        ) : null}
      </header>

      <div className="banners">
        {offline ? (
          <Banner tone="warning">
            Offline. Sales are saved on this register and sent when the connection is back.
          </Banner>
        ) : null}
        {recovered ? (
          <Banner tone="info">
            Recovered: your open order was restored after a restart.
            <Button onClick={() => cartService.dismissRecovered()}>Dismiss</Button>
          </Banner>
        ) : null}
        {printerDown ? (
          <Banner tone="warning">
            Receipt printer offline{printer.status?.detail ? `: ${printer.status.detail}` : ''}.
            Sales are still saved; receipts print when it is back.
            <Button onClick={printer.recheck}>Retry</Button>
            <Button onClick={() => onNavigate('diagnostics')}>Open diagnostics</Button>
          </Banner>
        ) : null}
        {syncStatus.replica?.source === 'stub' ? (
          <Banner tone="info">
            Demo catalogue: the server has no catalogue feed yet, so products shown are sample data.
          </Banner>
        ) : null}
        {notice ? <Banner tone={notice.tone}>{notice.text}</Banner> : null}
      </div>

      <main className="workspace" inert={menuOpen}>
        <CartPane
          collapsible={collapsible}
          collapsed={collapsed(collapsible, cartCollapsed)}
          onToggle={() => setCartCollapsed((c) => !c)}
        />
        <ProductPane onResult={onResult} searchRef={searchRef} />
      </main>

      <footer className="tender-bar" aria-label="Tender" inert={menuOpen}>
        <Button tender disabled title="Cash payment arrives with the checkout slice (F6b)">
          CASH {formatMinor(cartSubtotalMinor(cart), currency)}
        </Button>
        <Button
          tender
          disabled
          title="Card payment arrives with payments (F5) and the checkout slice (F6b)"
        >
          {offline
            ? 'CARD (terminal may approve offline, up to limit)'
            : `CARD ${formatMinor(cartSubtotalMinor(cart), currency)}`}
        </Button>
        <Button tender disabled className="hide-handheld">
          Split
        </Button>
        <Button tender disabled className="hide-handheld">
          Other
        </Button>
        <p className="muted tender-note hide-handheld">
          Payments are not available in this build: the shell only prepares the order.
        </p>
      </footer>
    </div>
  );
}

const collapsed = (collapsible: boolean, value: boolean) => collapsible && value;
