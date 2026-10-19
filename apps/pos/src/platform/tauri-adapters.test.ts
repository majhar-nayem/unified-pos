import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import { TauriTcpTransport, createHardware, readHardwareConfig } from '../hardware/setup.js';
import { MemoryKeyValueStore } from './ports.js';
import { TauriDeviceKeys, TauriSecretStore } from './keys.js';

/**
 * These tests pin the TypeScript side of the Tauri command contract. The Rust side lives in
 * src-tauri/src/{keychain,tcp}.rs; a renamed command or argument fails here before it fails on a register.
 */
beforeEach(() => invokeMock.mockReset());

describe('keychain commands', () => {
  it('device key: ensure, sign and destroy call the matching commands', async () => {
    invokeMock
      .mockResolvedValueOnce('PUBKEY')
      .mockResolvedValueOnce('SIG')
      .mockResolvedValueOnce(undefined);
    const keys = new TauriDeviceKeys();
    expect(keys.kind).toBe('os_keychain');
    expect(await keys.ensure()).toBe('PUBKEY');
    expect(await keys.sign('nonce.device.tenant')).toBe('SIG');
    await keys.destroy();
    expect(invokeMock.mock.calls).toEqual([
      ['device_key_ensure', undefined],
      ['device_key_sign', { message: 'nonce.device.tenant' }],
      ['device_key_destroy', undefined],
    ]);
  });

  it('secrets: get, set and delete', async () => {
    invokeMock
      .mockResolvedValueOnce('token')
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const secrets = new TauriSecretStore();
    expect(await secrets.get('staff-refresh-token')).toBe('token');
    await secrets.set('staff-refresh-token', 'next');
    await secrets.delete('staff-refresh-token');
    expect(invokeMock.mock.calls).toEqual([
      ['secret_get', { name: 'staff-refresh-token' }],
      ['secret_set', { name: 'staff-refresh-token', value: 'next' }],
      ['secret_delete', { name: 'staff-refresh-token' }],
    ]);
  });
});

describe('TCP byte pipe commands', () => {
  it('open → write → read → close with the handle the Rust side returned', async () => {
    invokeMock
      .mockResolvedValueOnce(7) // tcp_open
      .mockResolvedValueOnce(undefined) // tcp_write
      .mockResolvedValueOnce([18, 18, 18]) // tcp_read
      .mockResolvedValueOnce(undefined); // tcp_close
    const transport = new TauriTcpTransport('10.0.0.5:9101');
    await transport.open();
    await transport.write(Uint8Array.of(0x10, 0x04, 0x01));
    expect(Array.from(await transport.read(3, 500))).toEqual([18, 18, 18]);
    await transport.close();
    expect(invokeMock.mock.calls).toEqual([
      ['tcp_open', { host: '10.0.0.5', port: 9101 }],
      ['tcp_write', { handle: 7, bytes: [0x10, 0x04, 0x01] }],
      ['tcp_read', { handle: 7, length: 3, timeoutMs: 500 }],
      ['tcp_close', { handle: 7 }],
    ]);
  });

  it('defaults to port 9100 and does not close what was never opened', async () => {
    invokeMock.mockResolvedValueOnce(1);
    const transport = new TauriTcpTransport('printer.lan');
    await transport.open();
    expect(invokeMock).toHaveBeenCalledWith('tcp_open', { host: 'printer.lan', port: 9100 });
    await new TauriTcpTransport('x').close();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

describe('hardware configuration', () => {
  it('reads the register hardware list and tolerates garbage', () => {
    const kv = new MemoryKeyValueStore();
    expect(readHardwareConfig(kv)).toEqual([]);
    kv.set('hardware.config', 'not json');
    expect(readHardwareConfig(kv)).toEqual([]);
    kv.set(
      'hardware.config',
      JSON.stringify([{ profile: 'epson-tm-t88-network', address: '10.0.0.5:9100' }]),
    );
    expect(readHardwareConfig(kv)).toHaveLength(1);
  });

  it('outside Tauri the full mock set is used and flagged as simulated', () => {
    const { manager, simulated } = createHardware(new MemoryKeyValueStore());
    expect(simulated).toBe(true);
    expect(manager.ofKind('receipt_printer')).toHaveLength(1);
    expect(manager.ofKind('scale')).toHaveLength(1);
  });

  it('inside Tauri only configured network printers are created; nothing configured means no peripherals', () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    try {
      const empty = createHardware(new MemoryKeyValueStore());
      expect(empty.simulated).toBe(false);
      expect(empty.manager.ofKind('receipt_printer')).toHaveLength(0);
      const kv = new MemoryKeyValueStore();
      kv.set(
        'hardware.config',
        JSON.stringify([
          {
            profile: 'epson-tm-t88-network',
            address: '10.0.0.5:9100',
            instanceId: 'front-printer',
          },
        ]),
      );
      const configured = createHardware(kv);
      expect(configured.manager.get('front-printer')?.profile).toMatchObject({
        address: '10.0.0.5:9100',
        kind: 'receipt_printer',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
