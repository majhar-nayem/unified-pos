import { afterEach, describe, expect, it } from 'vitest';

import { EscPosPrinter } from './escpos-printer.js';
import { encodeDocument } from './escpos.js';
import { MockPrinterServer } from './mock-printer-server.js';
import { TcpTransport, parseHostPort, tcpTransportFactory } from './node.js';
import { resolveProfile } from './profiles.js';

const servers: MockPrinterServer[] = [];
async function setup(options = {}) {
  const server = new MockPrinterServer(options);
  servers.push(server);
  const port = await server.start();
  const profile = resolveProfile('epson-tm-t88-network', { address: `127.0.0.1:${port}` });
  return {
    server,
    printer: new EscPosPrinter(profile, tcpTransportFactory, { statusTimeoutMs: 300 }),
  };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function until(fn: () => boolean, ms = 1000) {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
}

describe('EscPosPrinter over TCP 9100', () => {
  it('delivers the exact encoded bytes to the printer', async () => {
    const { server, printer } = await setup();
    const doc = {
      lines: ['Receipt 0001', { text: 'TOTAL 32.86', bold: true }],
      cut: true,
      openDrawer: true,
    };
    expect(await printer.print(doc)).toEqual({ ok: true });
    await until(() => server.jobs.length === 1);
    expect(server.jobs[0]!.equals(Buffer.from(encodeDocument(doc, { columns: 48 })))).toBe(true);
  });

  it('uses the profile column width and one connection per job', async () => {
    const { server, printer } = await setup();
    await printer.print({ lines: [{ rule: true }], cut: false });
    await printer.print({ lines: ['b'], cut: false });
    await until(() => server.jobs.length === 2);
    expect(server.connections).toBe(2);
    expect(server.jobs[0]!.toString('latin1')).toContain('-'.repeat(48));
  });

  it('kickDrawer sends only the pulse', async () => {
    const { server, printer } = await setup();
    expect(await printer.kickDrawer()).toEqual({ ok: true });
    await until(() => server.jobs.length === 1);
    expect(server.jobs[0]!.toString('hex')).toBe('1b40' + '1b7000' + '3232');
  });

  it('an unreachable printer is a retryable failure and nothing is sent', async () => {
    const { server, printer } = await setup();
    await server.stop();
    const result = await printer.print({ lines: ['x'] });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toMatch(/unreachable/i);
    expect(await printer.status()).toMatchObject({ online: false, state: 'offline' });
  });

  it('reports ready, paper low, paper out and cover open from status bytes', async () => {
    const ready = await setup({ status: [0x12, 0x12, 0x12] });
    expect(await ready.printer.status()).toMatchObject({
      online: true,
      state: 'ready',
      paperOut: false,
    });

    const low = await setup({ status: [0x12, 0x12, 0x0c + 0x12] });
    expect(await low.printer.status()).toMatchObject({
      online: true,
      state: 'degraded',
      paperLow: true,
    });

    const out = await setup({ status: [0x12, 0x12, 0x72] });
    expect(await out.printer.status()).toMatchObject({
      online: false,
      paperOut: true,
      detail: 'paper out',
    });

    const cover = await setup({ status: [0x12, 0x16, 0x12] });
    expect(await cover.printer.status()).toMatchObject({ online: false, coverOpen: true });
  });

  it('a printer that connects but stays silent is reachable with unknown state', async () => {
    const { printer } = await setup();
    expect(await printer.status()).toMatchObject({ online: true, state: 'unknown' });
  });
});

describe('TcpTransport helpers', () => {
  it('parses host:port with a 9100 default', () => {
    expect(parseHostPort('10.0.0.5:9101')).toEqual({ host: '10.0.0.5', port: 9101 });
    expect(parseHostPort('printer.lan')).toEqual({ host: 'printer.lan', port: 9100 });
  });

  it('rejects writes before open and times out reads', async () => {
    const server = new MockPrinterServer();
    servers.push(server);
    const port = await server.start();
    const t = new TcpTransport({ host: '127.0.0.1', port });
    await expect(t.write(Uint8Array.of(1))).rejects.toThrow(/not open/);
    await t.open();
    const started = Date.now();
    expect((await t.read(3, 80)).length).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    await t.close();
  });
});
