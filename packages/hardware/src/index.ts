/**
 * Peripheral abstractions, device profiles, mock drivers and the ESC/POS network printer driver
 * (docs/03-implementation-plan.md §1, Hardware row; slice F6). Browser-safe: the Node TCP transport
 * lives in `@pos/hardware/node`.
 */
export * from './types.js';
export * from './escpos.js';
export * from './escpos-printer.js';
export * from './wedge.js';
export * from './mocks.js';
export * from './profiles.js';
export * from './manager.js';
