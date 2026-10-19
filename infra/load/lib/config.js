/* global __ENV */
// Configuration for the F10 load profile (docs/03-implementation-plan.md §5 F10, §9; SLOs in docs/01 §12.1).
// Everything is an environment variable so the same script runs against local, staging and (carefully) prod-like stacks:
//   k6 run -e BASE_URL=https://api.staging.example.com -e OPERATOR_TOKEN=... -e PROFILE=full infra/load/f10.js

function env(name, fallback) {
  const value = __ENV[name];
  return value === undefined || value === '' ? fallback : value;
}

function int(name, fallback) {
  return parseInt(env(name, String(fallback)), 10);
}

export const BASE_URL = env('BASE_URL', 'http://localhost:3000').replace(/\/+$/, '');
export const PROFILE = env('PROFILE', 'smoke');

// Platform operator token (AUTH_OPERATOR_TOKENS): used by setup() to provision a throwaway tenant.
export const OPERATOR_TOKEN = env('OPERATOR_TOKEN', '');

export const PASSWORD = env('LOAD_PASSWORD', 'correct horse battery staple');

// Each profile: how many registers (concurrent VUs doing scan lookups), the sustained order rate, the duration,
// and the store-open catalog sync burst (10x the steady catalog sync rate, docs/03 §9 Load).
const PROFILES = {
  // One pass through every flow: proves the script and the environment, no SLO claim.
  smoke: {
    registers: 2,
    ordersPerSecond: 1,
    ramp: '5s',
    hold: '15s',
    burstFactor: 1,
    burstAt: '5s',
    burstFor: '5s',
    users: 2,
    items: 5,
  },
  // A fraction of the target on a small staging stack.
  staging: {
    registers: 100,
    ordersPerSecond: 20,
    ramp: '1m',
    hold: '5m',
    burstFactor: 10,
    burstAt: '2m',
    burstFor: '1m',
    users: 20,
    items: 25,
  },
  // F10: 1k registers, 200 orders/s sustained.
  full: {
    registers: 1000,
    ordersPerSecond: 200,
    ramp: '5m',
    hold: '20m',
    burstFactor: 10,
    burstAt: '10m',
    burstFor: '2m',
    users: 100,
    items: 50,
  },
};

const base = PROFILES[PROFILE];
if (!base) {
  throw new Error(`unknown PROFILE "${PROFILE}"; use one of ${Object.keys(PROFILES).join(', ')}`);
}

export const LOAD = {
  registers: int('REGISTERS', base.registers),
  ordersPerSecond: int('ORDERS_PER_SECOND', base.ordersPerSecond),
  ramp: env('RAMP', base.ramp),
  hold: env('HOLD', base.hold),
  // Catalog sync: pages of items per second at steady state; the burst multiplies it.
  catalogSyncPerSecond: int('CATALOG_SYNC_PER_SECOND', 5),
  burstFactor: int('BURST_FACTOR', base.burstFactor),
  burstAt: env('BURST_AT', base.burstAt),
  burstFor: env('BURST_FOR', base.burstFor),
  // Cashier accounts shared across the VUs (each VU holds its own session; sessions rotate independently).
  users: int('USERS', base.users),
  items: int('ITEMS', base.items),
  linesPerOrder: int('LINES_PER_ORDER', 3),
  // Re-login before the 15 minute web token expires.
  sessionMaxAgeSeconds: int('SESSION_MAX_AGE_SECONDS', 600),
};

// §12.1 objectives. Availability 99.95 % monthly leaves an error budget of 0.05 %.
export const SLO = {
  lookupP95Ms: 200,
  apiP95Ms: 300,
  commitP95Ms: 500,
  errorRate: 0.0005,
};
