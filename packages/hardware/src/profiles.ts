/**
 * Device profiles: what a model can do and how to reach it. Tenants pick a profile in the register
 * setup and add an address; the registry turns that into a driver instance.
 */
import type { DeviceProfile } from './types.js';

export const BUILTIN_PROFILES = {
  'epson-tm-t88-network': {
    id: 'epson-tm-t88-network',
    name: 'Epson TM-T88 (network)',
    kind: 'receipt_printer',
    transport: 'network',
    capabilities: ['print_escpos', 'drawer_kick', 'cutter'],
    options: { columns: 48, port: 9100 },
  },
  'epson-tm-t20-usb': {
    id: 'epson-tm-t20-usb',
    name: 'Epson TM-T20 (USB)',
    kind: 'receipt_printer',
    transport: 'usb',
    capabilities: ['print_escpos', 'drawer_kick', 'cutter'],
    options: { columns: 48 },
  },
  'generic-58mm-bluetooth': {
    id: 'generic-58mm-bluetooth',
    name: 'Generic 58 mm receipt printer (Bluetooth)',
    kind: 'receipt_printer',
    transport: 'bluetooth',
    capabilities: ['print_escpos'],
    options: { columns: 32 },
  },
  'kitchen-escpos-network': {
    id: 'kitchen-escpos-network',
    name: 'Kitchen ticket printer (network)',
    kind: 'kitchen_printer',
    transport: 'network',
    capabilities: ['print_escpos', 'cutter'],
    options: { columns: 42, port: 9100 },
  },
  'hid-wedge-scanner': {
    id: 'hid-wedge-scanner',
    name: 'HID keyboard-wedge scanner',
    kind: 'scanner',
    transport: 'usb',
    capabilities: ['barcode_scan'],
  },
  'serial-scale-ntep': {
    id: 'serial-scale-ntep',
    name: 'Serial scale (NTEP, continuous output)',
    kind: 'scale',
    transport: 'serial',
    capabilities: ['weigh_ntep'],
    options: { baud: 9600 },
  },
  'bluetooth-scale-oiml': {
    id: 'bluetooth-scale-oiml',
    name: 'Bluetooth scale (OIML)',
    kind: 'scale',
    transport: 'bluetooth',
    capabilities: ['weigh_oiml'],
  },
  'customer-display-window': {
    id: 'customer-display-window',
    name: 'Customer-facing display (second window)',
    kind: 'customer_display',
    transport: 'builtin',
    capabilities: ['display_text'],
  },
} as const satisfies Record<string, DeviceProfile>;

export type BuiltinProfileId = keyof typeof BUILTIN_PROFILES;

export class UnknownProfileError extends Error {
  constructor(id: string) {
    super(`Unknown device profile "${id}"`);
    this.name = 'UnknownProfileError';
  }
}

/** Instantiate a configured profile (profile id + the address the tenant entered). */
export function resolveProfile(
  id: string,
  overrides: {
    readonly address?: string;
    readonly name?: string;
    readonly instanceId?: string;
  } = {},
  extra: Readonly<Record<string, DeviceProfile>> = {},
): DeviceProfile {
  const base = (extra[id] ?? (BUILTIN_PROFILES as Record<string, DeviceProfile>)[id]) as
    DeviceProfile | undefined;
  if (!base) throw new UnknownProfileError(id);
  if (base.transport !== 'builtin' && !overrides.address)
    throw new TypeError(`Profile "${id}" needs an address (${base.transport})`);
  return {
    ...base,
    id: overrides.instanceId ?? base.id,
    name: overrides.name ?? base.name,
    ...(overrides.address ? { address: overrides.address } : {}),
  };
}
