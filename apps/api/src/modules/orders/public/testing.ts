/**
 * Test support for modules that exercise orders over HTTP (receipts integration tests). Kept apart
 * from the production surface in ./index.ts so nothing in a running API imports supertest.
 */
export { buildOrdersWorld } from '../testing/orders-world.js';
export type { OrdersWorld, Actor } from '../testing/orders-world.js';
export {
  client,
  ifMatch,
  line,
  outbox,
  auditActions,
  port,
  seedOrderFixtures,
} from '../testing/helpers.js';
