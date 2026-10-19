/* global __VU */
// F10 load profile (docs/03-implementation-plan.md §5 F10 and §9): 1k registers, 200 orders/s sustained,
// 10x catalog sync burst at store open. Thresholds are the objectives in docs/01-system-architecture.md §12.1.
//
//   k6 run -e BASE_URL=https://api.staging.example.com -e OPERATOR_TOKEN=op_... -e PROFILE=staging infra/load/f10.js
//
// PROFILE: smoke | staging | full. Any value in lib/config.js can be overridden (REGISTERS, ORDERS_PER_SECOND, ...).
// Flow per order: three scan lookups, then POST /v1/orders with the lines, then POST /v1/orders/{id}/place
// (checkout commit, payment excluded). Registers also scan on their own at human pace. The burst scenario pages through
// the catalog the way a device syncs at store open.

import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

import { call, explain, json, uuid } from './lib/api.js';
import { BASE_URL, LOAD, PASSWORD, PROFILE, SLO } from './lib/config.js';
import { seed } from './lib/seed.js';

const ordersPlaced = new Counter('orders_placed');
const orderFlow = new Trend('order_flow_duration', true);
const sessionLogins = new Counter('session_logins');

const burst = LOAD.burstFactor > 1;

export const options = {
  scenarios: {
    registers: {
      executor: 'ramping-vus',
      exec: 'register',
      startVUs: 0,
      stages: [
        { duration: LOAD.ramp, target: LOAD.registers },
        { duration: LOAD.hold, target: LOAD.registers },
      ],
      gracefulRampDown: '30s',
    },
    orders: {
      executor: 'ramping-arrival-rate',
      exec: 'order',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: Math.max(10, Math.ceil(LOAD.ordersPerSecond * 1.5)),
      maxVUs: Math.max(20, LOAD.ordersPerSecond * 6),
      stages: [
        { duration: LOAD.ramp, target: LOAD.ordersPerSecond },
        { duration: LOAD.hold, target: LOAD.ordersPerSecond },
      ],
    },
    ...(burst
      ? {
          store_open_catalog_sync: {
            executor: 'constant-arrival-rate',
            exec: 'catalogSync',
            startTime: LOAD.burstAt,
            duration: LOAD.burstFor,
            rate: LOAD.catalogSyncPerSecond * LOAD.burstFactor,
            timeUnit: '1s',
            preAllocatedVUs: Math.max(5, LOAD.catalogSyncPerSecond * LOAD.burstFactor),
            maxVUs: Math.max(20, LOAD.catalogSyncPerSecond * LOAD.burstFactor * 4),
          },
        }
      : {}),
  },
  thresholds:
    PROFILE === 'smoke'
      ? { checks: ['rate>0.99'] }
      : {
          'http_req_duration{kind:lookup}': [`p(95)<${SLO.lookupP95Ms}`],
          'http_req_duration{kind:api}': [`p(95)<${SLO.apiP95Ms}`],
          'http_req_duration{kind:commit}': [`p(95)<${SLO.commitP95Ms}`],
          'http_req_failed{kind:lookup}': [`rate<${SLO.errorRate}`],
          'http_req_failed{kind:api}': [`rate<${SLO.errorRate}`],
          'http_req_failed{kind:commit}': [`rate<${SLO.errorRate}`],
          // The arrival rate must actually be sustained: any dropped iteration means the system fell behind.
          'dropped_iterations{scenario:orders}': ['count==0'],
          checks: [`rate>${1 - SLO.errorRate}`],
        },
  // Keep the raw per-route breakdown out of the summary; the tagged sub-metrics above carry the SLOs.
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  console.log(
    `F10 profile "${PROFILE}" against ${BASE_URL}: ${LOAD.registers} registers, ${LOAD.ordersPerSecond} orders/s`,
  );
  return seed();
}

// --- sessions: one per VU, re-created before the access token expires ------------------------------------------------

let session = null;

function login(data) {
  const email = data.users[(__VU - 1) % data.users.length];
  const response = call('POST', '/auth/login', {
    kind: 'auth',
    name: 'POST /auth/login',
    body: { tenantSlug: data.slug, email, password: PASSWORD },
  });
  const ok = check(response, { 'cashier login succeeds': (r) => r.status === 200 });
  if (!ok) return null;
  sessionLogins.add(1);
  return { token: json(response).tokens.accessToken, startedAt: Date.now() };
}

function token(data) {
  if (!session || Date.now() - session.startedAt > LOAD.sessionMaxAgeSeconds * 1000)
    session = login(data);
  return session ? session.token : null;
}

function etagOf(response) {
  for (const key of Object.keys(response.headers)) {
    if (key.toLowerCase() === 'etag') return response.headers[key];
  }
  return null;
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function scan(data, accessToken, variant) {
  const response = call('GET', `/variants/by-barcode?code=${variant.barcode}`, {
    token: accessToken,
    kind: 'lookup',
    name: 'GET /variants/by-barcode',
  });
  if (!check(response, { 'scan finds the variant': (r) => r.status === 200 }))
    explain(response, 'scan');
  return response;
}

// --- scenarios ------------------------------------------------------------------------------------------------

/** A register idling between sales: scans at human pace, with the occasional catalog page. */
export function register(data) {
  const accessToken = token(data);
  if (!accessToken) return sleep(1);
  scan(data, accessToken, pick(data.variants));
  sleep(2 + Math.random() * 3);
}

/** One sale: scan, create the order with its lines, place it. */
export function order(data) {
  const accessToken = token(data);
  if (!accessToken) return;
  const started = Date.now();

  const chosen = [];
  for (let i = 0; i < LOAD.linesPerOrder; i += 1) chosen.push(pick(data.variants));
  for (const variant of chosen) scan(data, accessToken, variant);

  const created = call('POST', '/orders', {
    token: accessToken,
    kind: 'api',
    name: 'POST /orders',
    body: {
      locationId: data.locationId,
      kind: 'retail_sale',
      clientOrderRef: uuid().slice(0, 32),
      lines: chosen.map((variant) => ({
        variantId: variant.id,
        item: { name: variant.name, sku: variant.sku },
        listPriceMinor: variant.priceMinor,
        quantity: String(1 + Math.floor(Math.random() * 3)),
      })),
    },
  });
  const orderOk = check(created, {
    'order is created': (r) => r.status === 200 || r.status === 201,
  });
  if (!orderOk) return explain(created, 'create order');

  const order = json(created);
  const placed = call('POST', `/orders/${order.id}/place`, {
    token: accessToken,
    kind: 'commit',
    name: 'POST /orders/:id/place',
    body: {},
    // Optimistic concurrency: the create response's ETag, else its version (docs/01 §5.1: If-Match → 428/412).
    headers: { 'if-match': etagOf(created) || `"${order.version}"` },
  });
  if (check(placed, { 'order is placed': (r) => r.status === 200 || r.status === 201 })) {
    ordersPlaced.add(1);
    orderFlow.add(Date.now() - started);
  } else {
    explain(placed, 'place order');
  }
}

/** A device syncing the catalog at store open: page through items. */
export function catalogSync(data) {
  const accessToken = token(data);
  if (!accessToken) return;
  const page = call('GET', '/items?limit=100', {
    token: accessToken,
    kind: 'api',
    name: 'GET /items',
  });
  check(page, { 'catalog page is served': (r) => r.status === 200 });
}
