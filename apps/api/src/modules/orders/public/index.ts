/** Public surface of the orders module. Other modules and the app shell import ONLY from here. */
export { OrdersModule } from '../orders.module.js';
export { OrderPortService } from '../order-port.service.js';
export { OrderRepository } from '../order.repository.js';
export { OrderCommitter, orderEvent, orderSummary } from '../order.committer.js';
export { LocationReadModel } from '../location.read-model.js';
export type { LocationFacts } from '../location.read-model.js';
export { CommandContextFactory } from '../command-context.factory.js';
export { PRICING_PORT, CATALOG_PORT } from '../ports.js';
export { toOrderDto } from '../order.rows.js';
export { domain } from '../domain.js';
export type {
  OrderState,
  OrderLine,
  Check,
  ReducerResult,
  OrderEvent,
  CommandContext,
  ReceiptKind,
} from '../domain.js';
export { mapRuleError, rules } from '../rule-errors.js';
