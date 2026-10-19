/**
 * Customer-facing display (CFD) mirror. The register publishes a read-only snapshot of the cart on a
 * BroadcastChannel; the CFD window (same app, `?mode=cfd`) renders it. Both Tauri windows share one
 * origin, so no server round trip or IPC is needed and the display keeps working offline.
 */
export const CFD_CHANNEL = 'pos-cfd';

export interface CfdLine {
  readonly name: string;
  readonly quantity: string;
  readonly totalMinor: string;
}

export type CfdMessage =
  | {
      readonly type: 'cart';
      readonly currency: string;
      readonly lines: readonly CfdLine[];
      readonly totalMinor: string;
    }
  | { readonly type: 'idle' };

export interface CfdTransport {
  postMessage(message: CfdMessage): void;
  onmessage: ((event: { data: CfdMessage }) => void) | null;
  close(): void;
}

export function openCfdChannel(name = CFD_CHANNEL): CfdTransport {
  return new BroadcastChannel(name) as unknown as CfdTransport;
}

/** Open the CFD window: a second Tauri webview window, or a browser window in dev. */
export async function openCfdWindow(isTauriRuntime: boolean): Promise<void> {
  if (!isTauriRuntime) {
    window.open('/?mode=cfd', 'pos-cfd', 'popup,width=1280,height=800');
    return;
  }
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const existing = await WebviewWindow.getByLabel('cfd');
  if (existing) {
    await existing.setFocus();
    return;
  }
  const { availableMonitors, currentMonitor } = await import('@tauri-apps/api/window');
  const [current, monitors] = await Promise.all([currentMonitor(), availableMonitors()]);
  // Prefer a second screen; with one screen the CFD opens as a normal window the cashier can move.
  const second = monitors.find((m) => m.name !== current?.name);
  const win = new WebviewWindow('cfd', {
    url: 'index.html?mode=cfd',
    title: 'Customer display',
    width: 1280,
    height: 800,
    ...(second
      ? {
          x: second.position.x / second.scaleFactor,
          y: second.position.y / second.scaleFactor,
          fullscreen: true,
        }
      : {}),
  });
  await new Promise<void>((resolve, reject) => {
    void win.once('tauri://created', () => resolve());
    void win.once('tauri://error', (e) => reject(new Error(String(e.payload))));
  });
}
