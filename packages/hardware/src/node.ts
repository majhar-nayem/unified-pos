/**
 * Node-only transports. Kept out of the main entry so the browser/Tauri webview bundle never
 * imports `node:net`. In the Tauri app the same `ByteTransport` is implemented by a Rust command.
 */
import { Socket } from 'node:net';

import type { ByteTransport } from './types.js';

export interface TcpTransportOptions {
  readonly host: string;
  readonly port: number;
  readonly connectTimeoutMs?: number;
}

export class TcpTransport implements ByteTransport {
  private socket: Socket | null = null;
  private received: Buffer[] = [];
  private waiter: (() => void) | null = null;

  constructor(private readonly options: TcpTransportOptions) {}

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const timer = setTimeout(
        () =>
          socket.destroy(new Error(`Connect timeout to ${this.options.host}:${this.options.port}`)),
        this.options.connectTimeoutMs ?? 2000,
      );
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.on('data', (chunk) => {
        this.received.push(chunk);
        this.waiter?.();
      });
      socket.connect(this.options.port, this.options.host, () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        socket.on('error', () => this.waiter?.());
        this.socket = socket;
        resolve();
      });
    });
  }

  write(bytes: Uint8Array): Promise<void> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error('Transport is not open'));
    return new Promise((resolve, reject) => {
      socket.write(bytes, (error) => (error ? reject(error) : resolve()));
    });
  }

  async read(length: number, timeoutMs: number): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    while (Buffer.concat(this.received).length < length) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.waiter = null;
    }
    const all = Buffer.concat(this.received);
    const out = all.subarray(0, length);
    this.received = all.length > length ? [all.subarray(length)] : [];
    return Uint8Array.from(out);
  }

  close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return Promise.resolve();
    return new Promise((resolve) => {
      socket.end(() => resolve());
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 250).unref();
    });
  }
}

export function parseHostPort(address: string, defaultPort = 9100): { host: string; port: number } {
  const match = /^(.+?)(?::(\d{1,5}))?$/.exec(address.trim());
  if (!match) throw new TypeError(`Invalid network address "${address}"`);
  return { host: match[1]!, port: match[2] ? Number(match[2]) : defaultPort };
}

/** `TransportFactory` for network profiles. */
export function tcpTransportFactory(profile: { readonly address?: string }): TcpTransport {
  if (!profile.address) throw new TypeError('Network profile has no address');
  return new TcpTransport(parseHostPort(profile.address));
}
export { MockPrinterServer, type MockPrinterServerOptions } from './mock-printer-server.js';
