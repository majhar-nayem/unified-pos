/** A fake network printer for tests: accepts TCP connections on a port, records bytes, answers DLE EOT. */
import { createServer, type Server, type Socket } from 'node:net';

export interface MockPrinterServerOptions {
  /** Status bytes returned for DLE EOT 1/2/4 (in that order). Undefined = stay silent. */
  readonly status?: readonly [number, number, number];
  /** Drop the connection after this many bytes, simulating a cable pulled mid-job. */
  readonly dropAfterBytes?: number;
}

export class MockPrinterServer {
  readonly jobs: Buffer[] = [];
  connections = 0;
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  port = 0;

  constructor(public options: MockPrinterServerOptions = {}) {}

  start(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => {
        this.connections += 1;
        this.sockets.add(socket);
        const chunks: Buffer[] = [];
        socket.on('data', (data) => {
          chunks.push(data);
          const all = Buffer.concat(chunks);
          if (
            this.options.status &&
            all.subarray(-9).equals(Buffer.from([0x10, 4, 1, 0x10, 4, 2, 0x10, 4, 4]))
          ) {
            socket.write(Buffer.from(this.options.status));
            chunks.length = 0;
            return;
          }
          if (
            this.options.dropAfterBytes !== undefined &&
            all.length >= this.options.dropAfterBytes
          ) {
            socket.destroy();
          }
        });
        socket.on('close', () => {
          this.sockets.delete(socket);
          if (chunks.length > 0) this.jobs.push(Buffer.concat(chunks));
        });
        socket.on('error', () => undefined);
      });
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        this.port = (server.address() as { port: number }).port;
        resolve(this.port);
      });
    });
  }

  stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }
}
